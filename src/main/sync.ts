import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { contentHash, packSlots, readHeader, unpackSlots } from './archive'
import { expand } from './savepaths'
import { store } from './store'
import type {
  ConflictChoice,
  Game,
  SyncAccount,
  SyncDevice,
  SyncResult,
  SyncServerInfo
} from '../shared/types'

/**
 * Sync client for the self-hosted server in ../../server.
 *
 * The server is a plain store: it never merges. All merging happens here, which
 * keeps one implementation of the rules and lets the server stay something you
 * can read in one sitting.
 */

interface RemoteGame {
  key: string
  title: string
  titleEdited: boolean
  tags: string[]
  notes: string
  favorite: boolean
  hidden: boolean
  /** Playtime per device, summed for display. Each device only writes its own. */
  playtime: Record<string, number>
  lastPlayed: number | null
  coverBlob: string | null
  savePaths: string[]
  updatedAt: number
  save: { versionId: string; hash: string; capturedAt: number; deviceName: string } | null
}

interface RemoteLibrary {
  rev: number
  updatedAt: number
  games: Record<string, RemoteGame>
  vault: { hash: string | null; salt: string | null; updatedAt: number } | null
}

/**
 * Identifies a game across devices. Paths differ per machine, so the title is
 * the only thing both sides agree on — and titles are already made unique by the
 * scanner's duplicate handling.
 */
export function gameKey(game: Game): string {
  const normalised = game.title.toLowerCase().replace(/[^a-z0-9]/g, '')
  return createHash('sha1').update(normalised).digest('hex').slice(0, 32)
}

/**
 * A location is only worth sharing if it is written in tokens, since those
 * expand to the right folder on any machine. Anything else describes one
 * device's disk and stays there.
 */
const isPortable = (savePath: string): boolean => savePath.startsWith('{')

function backupDir(): string {
  const dir = path.join(app.getPath('userData'), 'save-backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function coversDir(): string {
  const dir = path.join(app.getPath('userData'), 'covers')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// --- transport ---------------------------------------------------------------

class SyncError extends Error {}

async function request(
  method: string,
  route: string,
  body?: Buffer | object,
  expectBuffer = false
): Promise<{ status: number; json?: any; buffer?: Buffer }> {
  const { syncUrl, syncToken } = store.settings
  if (!syncUrl) throw new SyncError('No sync server configured.')

  const isBuffer = Buffer.isBuffer(body)
  let response: Response
  try {
    response = await fetch(`${syncUrl.replace(/\/+$/, '')}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${syncToken ?? ''}`,
        ...(body ? { 'Content-Type': isBuffer ? 'application/octet-stream' : 'application/json' } : {})
      },
      body: body ? (isBuffer ? new Uint8Array(body) : JSON.stringify(body)) : undefined
    })
  } catch (err) {
    throw new SyncError(`Cannot reach ${syncUrl} — ${(err as Error).message}`)
  }

  if (response.status === 401 && !route.startsWith('/v1/auth/')) {
    throw new SyncError('The server no longer recognises this device — sign in again.')
  }
  if (expectBuffer && response.ok) {
    return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) }
  }
  const text = await response.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    throw new SyncError(`Unexpected reply from ${syncUrl} (is that the sync server?)`)
  }
  return { status: response.status, json }
}

/**
 * Uploads that a proxy would refuse in one piece.
 *
 * Cloudflare caps a request body at 100 MB on its free and Pro plans, and other
 * proxies have their own limits, so the server advertises what it will take in
 * one request and anything larger goes up in parts. The parts are sent one at a
 * time on purpose: a home connection's upstream is the bottleneck, and running
 * several in parallel only makes each slower while risking a proxy's
 * concurrency limits.
 */
async function uploadChunked(
  data: Buffer,
  target: Record<string, unknown>,
  chunkSize: number,
  onProgress?: (sent: number, total: number) => void
): Promise<any> {
  const begin = await request('POST', '/v1/uploads', {})
  if (begin.status !== 200) throw new SyncError(begin.json?.error ?? 'The server would not start an upload.')
  const uploadId = begin.json.uploadId as string
  const size = Math.min(chunkSize, (begin.json.chunkSize as number) || chunkSize)

  for (let index = 0, sent = 0; sent < data.length; index++) {
    const part = data.subarray(sent, sent + size)
    const put = await request('PUT', `/v1/uploads/${uploadId}/${index}`, part)
    if (put.status !== 200) throw new SyncError(put.json?.error ?? 'A chunk was rejected.')
    sent += part.length
    onProgress?.(sent, data.length)
  }

  const done = await request('POST', `/v1/uploads/${uploadId}/finish`, { target })
  if (done.status !== 200) throw new SyncError(done.json?.error ?? 'The server could not assemble the upload.')
  return done.json
}

/** What the server will accept in one request; learned from /health, then cached. */
let maxBodyBytes: number | null = null

async function bodyLimit(): Promise<number> {
  if (maxBodyBytes !== null) return maxBodyBytes
  const health = await request('GET', '/health')
  maxBodyBytes = Number(health.json?.maxBodyBytes) || 8 * 1024 * 1024
  return maxBodyBytes
}

// --- accounts ----------------------------------------------------------------

export async function serverInfo(url: string): Promise<SyncServerInfo> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/health`)
    const json = (await response.json()) as Record<string, unknown>
    if (json?.service !== 'prcy-sync') return { ok: false, error: 'That is not a PRCY sync server.' }
    return {
      ok: true,
      accounts: Boolean(json.accounts),
      registrationOpen: Boolean(json.registrationOpen),
      maxBodyBytes: Number(json.maxBodyBytes) || undefined
    }
  } catch (err) {
    return { ok: false, error: `Cannot reach ${url} — ${(err as Error).message}` }
  }
}

/** Signs in and stores the device token. The password itself is never kept. */
export async function signIn(
  username: string,
  password: string,
  inviteCode?: string
): Promise<{ ok: boolean; error?: string; username?: string }> {
  try {
    const route = inviteCode ? '/v1/auth/register' : '/v1/auth/login'
    const body: Record<string, unknown> = {
      username,
      password,
      deviceName: store.settings.deviceName || os.hostname()
    }
    if (inviteCode) body.code = inviteCode

    const res = await request('POST', route, body)
    if (res.status !== 200) return { ok: false, error: res.json?.error ?? 'Sign-in failed.' }
    store.updateSettings({ syncToken: res.json.token, syncUsername: res.json.username })
    maxBodyBytes = null
    return { ok: true, username: res.json.username }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function signOut(): Promise<void> {
  try {
    await request('POST', '/v1/auth/logout', {})
  } catch {
    // The token is being thrown away either way; a server that cannot be
    // reached just keeps a session that nothing will ever present again.
  }
  store.updateSettings({ syncToken: null, syncUsername: null })
}

export async function listDevices(): Promise<SyncDevice[]> {
  const res = await request('GET', '/v1/auth/devices')
  return res.status === 200 ? (res.json.devices as SyncDevice[]) : []
}

export async function revokeDevice(id: string): Promise<boolean> {
  const res = await request('DELETE', `/v1/auth/devices/${encodeURIComponent(id)}`)
  return res.status === 200
}

export async function changeServerPassword(
  current: string,
  next: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await request('POST', '/v1/auth/password', { current, next })
    return res.status === 200 ? { ok: true } : { ok: false, error: res.json?.error ?? 'Failed.' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function testConnection(): Promise<{ ok: boolean; error?: string; account?: SyncAccount }> {
  try {
    const health = await request('GET', '/health')
    if (health.json?.service !== 'prcy-sync') return { ok: false, error: 'That is not a PRCY sync server.' }
    if (!store.settings.syncToken) return { ok: false, error: 'Not signed in to this server yet.' }
    // /health is unauthenticated, so make one authenticated call as well.
    const me = await request('GET', '/v1/auth/me')
    if (me.status !== 200) return { ok: false, error: 'The server rejected this device — sign in again.' }
    return { ok: true, account: me.json as SyncAccount }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// --- saves -------------------------------------------------------------------

function slotDirs(game: Game): string[] {
  return game.savePaths.map((token) => expand(token, game.folder))
}

/** Packs a game's configured save locations, or null when it has none set up. */
async function captureSaves(game: Game): Promise<{ archive: Buffer; hash: string } | null> {
  if (game.savePaths.length === 0) return null
  const archive = await packSlots(slotDirs(game), game.savePaths)
  const header = readHeader(archive)
  if (header.entries.length === 0) return null
  return { archive, hash: contentHash(archive) }
}

/** Keeps a copy of what is on disk before overwriting it with a remote save. */
async function backupLocal(game: Game, archive: Buffer): Promise<string> {
  const file = path.join(backupDir(), `${gameKey(game)}-${Date.now()}.prcysave`)
  await fsp.writeFile(file, archive)

  // Keep the ten most recent backups per game.
  const prefix = `${gameKey(game)}-`
  const mine = (await fsp.readdir(backupDir())).filter((n) => n.startsWith(prefix)).sort()
  for (const old of mine.slice(0, Math.max(0, mine.length - 10))) {
    await fsp.rm(path.join(backupDir(), old), { force: true })
  }
  return file
}

async function downloadSave(key: string, versionId: string): Promise<Buffer> {
  const res = await request('GET', `/v1/saves/${key}/${versionId}`, undefined, true)
  if (!res.buffer) throw new SyncError('Could not download that save version.')
  return res.buffer
}

async function uploadSave(
  game: Game,
  archive: Buffer,
  capturedAt: number,
  onProgress?: (sent: number, total: number) => void
): Promise<string> {
  const { deviceId, deviceName } = store.settings
  const limit = await bodyLimit()

  if (archive.length > limit) {
    const done = await uploadChunked(
      archive,
      { kind: 'save', key: gameKey(game), deviceId, deviceName, capturedAt },
      limit,
      onProgress
    )
    return done.versionId as string
  }

  const query = `?device=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(deviceName)}&capturedAt=${capturedAt}`
  const res = await request('POST', `/v1/saves/${gameKey(game)}${query}`, archive)
  if (res.status !== 200) throw new SyncError(res.json?.error ?? 'Upload failed.')
  return res.json.versionId as string
}

async function restoreSave(game: Game, archive: Buffer, hash: string, versionId: string): Promise<void> {
  const current = await captureSaves(game)
  if (current) await backupLocal(game, current.archive)
  await unpackSlots(archive, slotDirs(game))
  game.sync = { saveHash: hash, versionId, syncedAt: Date.now() }
}

// --- covers ------------------------------------------------------------------

async function pushCover(game: Game): Promise<string | null> {
  if (!game.coverPath || path.dirname(game.coverPath) !== coversDir()) return null
  let data: Buffer
  try {
    data = await fsp.readFile(game.coverPath)
  } catch {
    return null
  }
  const hash = createHash('sha256').update(data).digest('hex')
  const head = await request('HEAD', `/v1/blobs/${hash}`)
  if (head.status === 200) return hash
  // Cover art is a couple of hundred KB, but a hand-picked file could be
  // anything, so it takes the same route as a large save.
  if (data.length > (await bodyLimit())) {
    await uploadChunked(data, { kind: 'blob', hash }, await bodyLimit())
  } else {
    await request('PUT', `/v1/blobs/${hash}`, data)
  }
  return hash
}

async function pullCover(game: Game, hash: string): Promise<boolean> {
  const target = path.join(coversDir(), `${game.id}-${hash.slice(0, 8)}.img`)
  if (fs.existsSync(target)) {
    game.coverPath = target
    return false
  }
  const res = await request('GET', `/v1/blobs/${hash}`, undefined, true)
  if (!res.buffer) return false
  await fsp.writeFile(target, res.buffer)
  game.coverPath = target
  return true
}

// --- merge -------------------------------------------------------------------

function toRemote(game: Game, previous: RemoteGame | undefined, deviceId: string): RemoteGame {
  const playtime = { ...(previous?.playtime ?? {}) }
  // Only ever write this device's own figure; others keep theirs.
  playtime[deviceId] = game.playtimeSeconds
  return {
    key: gameKey(game),
    title: game.title,
    titleEdited: previous?.titleEdited ?? false,
    tags: game.tags,
    notes: game.notes,
    favorite: game.favorite,
    hidden: game.hidden,
    playtime,
    lastPlayed: game.lastPlayed,
    coverBlob: previous?.coverBlob ?? null,
    savePaths: game.savePaths.filter(isPortable),
    updatedAt: game.updatedAt,
    save: previous?.save ?? null
  }
}

/**
 * Fields the user edits move as a group, decided by whichever side was touched
 * last. Playtime is per device and summed, so two machines never overwrite each
 * other's hours.
 */
function mergeInto(game: Game, remote: RemoteGame, deviceId: string): boolean {
  let changed = false

  if (remote.updatedAt > game.updatedAt) {
    if (game.title !== remote.title) {
      game.title = remote.title
      changed = true
    }
    if (game.notes !== remote.notes || game.tags.join() !== remote.tags.join()) {
      game.notes = remote.notes
      game.tags = remote.tags
      changed = true
    }
    if (game.favorite !== remote.favorite || game.hidden !== remote.hidden) {
      game.favorite = remote.favorite
      game.hidden = remote.hidden
      changed = true
    }
    // Only tokenised locations mean the same thing on both machines. A raw
    // absolute path belongs to the device that added it and is kept out of the
    // merge, so one machine can never point another at its own folders.
    const merged = [...remote.savePaths.filter(isPortable), ...game.savePaths.filter((p) => !isPortable(p))]
    const unique = [...new Set(merged)]
    if (game.savePaths.join('|') !== unique.join('|')) {
      game.savePaths = unique
      changed = true
    }
    game.updatedAt = remote.updatedAt
  }

  if (remote.lastPlayed && (!game.lastPlayed || remote.lastPlayed > game.lastPlayed)) {
    game.lastPlayed = remote.lastPlayed
    changed = true
  }

  const others: Record<string, number> = {}
  for (const [device, seconds] of Object.entries(remote.playtime)) {
    if (device !== deviceId) others[device] = seconds
  }
  if (JSON.stringify(others) !== JSON.stringify(game.remotePlaytime ?? {})) {
    game.remotePlaytime = others
    changed = true
  }

  return changed
}

// --- the sync run ------------------------------------------------------------

/** Conflicts wait here between being reported and being resolved. */
const pendingConflicts = new Map<string, { game: Game; local: Buffer; remote: RemoteGame }>()

export async function syncNow(
  onProgress?: (phase: string, message: string) => void
): Promise<SyncResult> {
  const result: SyncResult = {
    ok: true,
    metadataChanged: 0,
    savesUploaded: 0,
    savesDownloaded: 0,
    coversUploaded: 0,
    coversDownloaded: 0,
    conflicts: []
  }

  try {
    const { deviceId } = store.settings
    if (!store.settings.syncToken) throw new SyncError('Sign in to the sync server first.')
    onProgress?.('metadata', 'Fetching library…')
    const fetched = await request('GET', '/v1/library')
    if (fetched.status !== 200) throw new SyncError(fetched.json?.error ?? 'Could not read the library.')
    const remote: RemoteLibrary = fetched.json

    // Vault: adopt the newer definition, so hidden games match everywhere.
    if (remote.vault?.hash && !store.settings.vaultHash) {
      store.updateSettings({ vaultHash: remote.vault.hash, vaultSalt: remote.vault.salt })
    }

    const games = store.games.filter((g) => !g.missing)
    const nextGames: Record<string, RemoteGame> = { ...remote.games }

    for (const game of games) {
      const key = gameKey(game)
      const remoteGame = remote.games[key]
      if (remoteGame && mergeInto(game, remoteGame, deviceId)) result.metadataChanged++

      onProgress?.('covers', game.title)
      let coverBlob = remoteGame?.coverBlob ?? null
      if (game.coverPath) {
        const pushed = await pushCover(game)
        if (pushed && pushed !== coverBlob) {
          coverBlob = pushed
          result.coversUploaded++
        }
      } else if (coverBlob) {
        if (await pullCover(game, coverBlob)) result.coversDownloaded++
      }

      onProgress?.('saves', game.title)
      const entry = toRemote(game, remoteGame, deviceId)
      entry.coverBlob = coverBlob
      // The merge may have taken remote values; publish what we now hold.
      entry.title = game.title
      entry.tags = game.tags
      entry.notes = game.notes
      entry.favorite = game.favorite
      entry.hidden = game.hidden
      entry.savePaths = game.savePaths.filter(isPortable)
      entry.lastPlayed = game.lastPlayed
      entry.updatedAt = game.updatedAt

      const local = await captureSaves(game)
      const known = game.sync ?? { saveHash: null, versionId: null, syncedAt: null }
      const localChanged = local !== null && local.hash !== known.saveHash
      const remoteSave = remoteGame?.save ?? null
      const remoteChanged = remoteSave !== null && remoteSave.hash !== known.saveHash

      if (localChanged && remoteChanged && local && remoteSave) {
        // Both sides moved since the last agreement: only the user can choose.
        const header = readHeader(local.archive)
        pendingConflicts.set(game.id, { game, local: local.archive, remote: entry })
        result.conflicts.push({
          gameId: game.id,
          gameKey: key,
          title: game.title,
          local: {
            capturedAt: header.createdAt,
            fileCount: header.entries.length,
            size: local.archive.length
          },
          remote: {
            versionId: remoteSave.versionId,
            capturedAt: remoteSave.capturedAt,
            deviceName: remoteSave.deviceName,
            size: 0
          }
        })
        entry.save = remoteSave
      } else if (localChanged && local) {
        const versionId = await uploadSave(game, local.archive, Date.now(), (sent, total) =>
          onProgress?.(
            'saves',
            `${game.title} — ${Math.round((sent / total) * 100)}% of ${Math.round(total / 1024 / 1024)} MB`
          )
        )
        game.sync = { saveHash: local.hash, versionId, syncedAt: Date.now() }
        entry.save = {
          versionId,
          hash: local.hash,
          capturedAt: Date.now(),
          deviceName: store.settings.deviceName
        }
        result.savesUploaded++
      } else if (remoteChanged && remoteSave) {
        const archive = await downloadSave(key, remoteSave.versionId)
        await restoreSave(game, archive, remoteSave.hash, remoteSave.versionId)
        entry.save = remoteSave
        result.savesDownloaded++
      } else {
        entry.save = remoteSave ?? entry.save
      }

      nextGames[key] = entry
    }

    onProgress?.('metadata', 'Publishing…')
    const vault = store.settings.vaultHash
      ? {
          hash: store.settings.vaultHash,
          salt: store.settings.vaultSalt,
          updatedAt: remote.vault?.updatedAt ?? Date.now()
        }
      : remote.vault
    const put = await request('PUT', '/v1/library', { baseRev: remote.rev, games: nextGames, vault })
    if (put.status === 409) {
      // Another device wrote while we worked; its values are already on the
      // server, so the next run will merge them rather than clobbering now.
      throw new SyncError('Another device synced at the same time — run sync again.')
    }
    if (put.status !== 200) throw new SyncError(put.json?.error ?? 'Could not publish the library.')

    store.updateSettings({ lastSyncAt: Date.now() })
    store.save()
    onProgress?.('done', 'Finished')
    return result
  } catch (err) {
    store.save()
    return { ...result, ok: false, error: (err as Error).message }
  }
}

/** Applies the user's decision for one conflicted game. */
export async function resolveConflict(gameId: string, choice: ConflictChoice): Promise<boolean> {
  const pending = pendingConflicts.get(gameId)
  if (!pending) return false
  pendingConflicts.delete(gameId)
  if (choice === 'skip') return true

  const { game, local, remote } = pending
  if (choice === 'local') {
    // Uploading does not delete the other version; the server keeps both.
    const hash = contentHash(local)
    const versionId = await uploadSave(game, local, Date.now())
    game.sync = { saveHash: hash, versionId, syncedAt: Date.now() }
  } else if (remote.save) {
    const archive = await downloadSave(remote.key, remote.save.versionId)
    await restoreSave(game, archive, remote.save.hash, remote.save.versionId)
  }
  store.save()
  return true
}

/** Called after a play session so the save travels without being asked. */
export async function syncGameSaves(gameId: string): Promise<void> {
  const game = store.findGame(gameId)
  if (!game || !store.settings.syncUrl || !store.settings.syncOnPlay) return
  if (game.savePaths.length === 0) return
  await syncNow()
}

export function ensureDeviceIdentity(): void {
  const patch: Record<string, unknown> = {}
  if (!store.settings.deviceId) patch.deviceId = randomUUID()
  if (!store.settings.deviceName) patch.deviceName = os.hostname()
  if (Object.keys(patch).length > 0) store.updateSettings(patch)
}
