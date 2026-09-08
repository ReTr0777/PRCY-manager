import { app, shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { gameId as folderId } from './scanner'
import { store } from './store'
import type { AppStorageUsage, DriveUsage, Game, StorageReport } from '../shared/types'

/**
 * Local disk accounting: what the library costs on *this* machine's drives.
 *
 * Nothing here syncs. A folder size describes one device's copy, and a game
 * deleted to free space on the laptop must not vanish from the desktop, so
 * sizes are written with the merge clock left alone.
 */

/**
 * Adds up a folder, iteratively so a deep game folder cannot blow the stack.
 * Unreadable entries are skipped rather than aborting the whole measurement —
 * a permission error on one file should not cost you the size of the game.
 *
 * There is no time limit on purpose: a walk that gives up early would report a
 * number that looks right and is not. Links are never followed, so it always
 * terminates.
 */
export async function measureFolder(root: string): Promise<{ bytes: number; files: number }> {
  const queue: string[] = [root]
  let bytes = 0
  let files = 0

  while (queue.length > 0) {
    const dir = queue.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      // Following a link would double-count at best and loop at worst.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        queue.push(full)
        continue
      }
      try {
        bytes += (await fsp.stat(full)).size
        files++
      } catch {
        /* vanished or locked mid-walk */
      }
    }
  }

  return { bytes, files }
}

/** The drive a path lives on: "D:\" on Windows, "/" elsewhere. */
export function driveOf(target: string): string {
  return path.parse(path.resolve(target)).root
}

async function measureGame(game: Game): Promise<number | null> {
  if (!fs.existsSync(game.folder)) return null
  const { bytes } = await measureFolder(game.folder)
  // Sizes are a local fact, so they must not stamp updatedAt and win a merge.
  store.updateGame(game.id, { sizeBytes: bytes, sizeScannedAt: Date.now() }, false)
  return bytes
}

/**
 * Measures games that have no size yet, or all of them when asked. Walking a
 * few hundred game folders takes a while, so it reports progress and can be
 * limited to the ones that are actually unknown.
 */
export async function measureGames(
  options: { all?: boolean; ids?: string[] } = {},
  onProgress?: (done: number, total: number, title: string) => void
): Promise<{ measured: number; bytes: number }> {
  const candidates = store.games.filter((game) => {
    if (game.missing) return false
    if (options.ids) return options.ids.includes(game.id)
    return options.all ? true : game.sizeBytes === null || game.sizeBytes === undefined
  })

  let measured = 0
  let bytes = 0
  for (const [index, game] of candidates.entries()) {
    onProgress?.(index + 1, candidates.length, game.title)
    const size = await measureGame(game)
    if (size !== null) {
      measured++
      bytes += size
    }
  }
  store.save()
  return { measured, bytes }
}

async function driveSpace(root: string): Promise<{ total: number; free: number } | null> {
  try {
    const stats = await fsp.statfs(root)
    return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize }
  } catch {
    // An unplugged drive or a network share that is not answering.
    return null
  }
}

async function folderUsage(dir: string): Promise<{ bytes: number; files: number }> {
  if (!fs.existsSync(dir)) return { bytes: 0, files: 0 }
  return measureFolder(dir)
}

async function appUsage(): Promise<AppStorageUsage> {
  const userData = app.getPath('userData')
  const covers = await folderUsage(path.join(userData, 'covers'))
  const backups = await folderUsage(path.join(userData, 'save-backups'))
  let library = 0
  try {
    library = fs.statSync(store.filePath).size
  } catch {
    /* first run, nothing written yet */
  }
  return {
    userDataPath: userData,
    libraryBytes: library,
    coverBytes: covers.bytes,
    coverCount: covers.files,
    backupBytes: backups.bytes,
    backupCount: backups.files
  }
}

/**
 * One row per drive that holds games, plus what the app itself is using.
 * Games with no measured size are counted separately so the totals never
 * pretend to be complete when they are not.
 */
export async function storageReport(): Promise<StorageReport> {
  const games = store.games.filter((g) => !g.missing)
  const byDrive = new Map<string, Game[]>()
  for (const game of games) {
    const drive = driveOf(game.folder)
    const list = byDrive.get(drive) ?? []
    list.push(game)
    byDrive.set(drive, list)
  }

  const drives: DriveUsage[] = []
  for (const [drive, list] of byDrive) {
    const space = await driveSpace(drive)
    const measured = list.filter((g) => typeof g.sizeBytes === 'number')
    drives.push({
      drive,
      // A root's label is a friendlier name than "D:\" when one exists.
      label: store.roots.find((r) => r.path && driveOf(r.path) === drive)?.label ?? drive,
      online: space !== null,
      totalBytes: space?.total ?? 0,
      freeBytes: space?.free ?? 0,
      gameBytes: measured.reduce((sum, g) => sum + (g.sizeBytes ?? 0), 0),
      gameCount: list.length,
      measuredCount: measured.length
    })
  }
  drives.sort((a, b) => b.gameBytes - a.gameBytes)

  return {
    drives,
    app: await appUsage(),
    unmeasured: games.filter((g) => typeof g.sizeBytes !== 'number').length,
    generatedAt: Date.now()
  }
}

/**
 * Sends a game's folder to the Recycle Bin and forgets the entry.
 *
 * Deliberately the bin and not an unlink: this is the one action in the app
 * that destroys something the user cannot re-download in a minute, and a
 * mis-click has to be recoverable.
 */
export async function deleteGameFiles(
  gameId: string
): Promise<{ ok: boolean; error?: string; freed: number }> {
  const game = store.findGame(gameId)
  if (!game) return { ok: false, error: 'No such game.', freed: 0 }

  const freed = game.sizeBytes ?? (await measureFolder(game.folder)).bytes
  try {
    if (fs.existsSync(game.folder)) await shell.trashItem(game.folder)
  } catch (err) {
    return { ok: false, error: `Could not move it to the Recycle Bin — ${(err as Error).message}`, freed: 0 }
  }
  store.removeGame(gameId)
  return { ok: true, freed }
}

/** Backups of saves that were replaced by a sync; safe to thin out. */
export async function trimSaveBackups(olderThanDays: number): Promise<{ removed: number; freed: number }> {
  const dir = path.join(app.getPath('userData'), 'save-backups')
  if (!fs.existsSync(dir)) return { removed: 0, freed: 0 }
  const cutoff = Date.now() - olderThanDays * 86_400_000
  let removed = 0
  let freed = 0
  for (const name of await fsp.readdir(dir)) {
    const full = path.join(dir, name)
    try {
      const stat = await fsp.stat(full)
      if (stat.mtimeMs > cutoff) continue
      freed += stat.size
      await fsp.rm(full, { force: true })
      removed++
    } catch {
      /* already gone */
    }
  }
  return { removed, freed }
}

/** Cover files no game points at any more — left behind by re-picked art. */
export async function pruneCovers(): Promise<{ removed: number; freed: number }> {
  const dir = path.join(app.getPath('userData'), 'covers')
  if (!fs.existsSync(dir)) return { removed: 0, freed: 0 }
  const inUse = new Set(
    store.games.map((g) => (g.coverPath ? path.resolve(g.coverPath).toLowerCase() : '')).filter(Boolean)
  )
  let removed = 0
  let freed = 0
  for (const name of await fsp.readdir(dir)) {
    const full = path.join(dir, name)
    if (inUse.has(full.toLowerCase())) continue
    try {
      freed += (await fsp.stat(full)).size
      await fsp.rm(full, { force: true })
      removed++
    } catch {
      /* already gone */
    }
  }
  return { removed, freed }
}

/**
 * Renames a game's folder on disk and repoints everything at the new path.
 *
 * The id is derived from the folder, so it has to move too: leaving the old one
 * would let a future game at the old path be given the same id. Tokenised save
 * paths need no work — {GAMEDIR} follows the folder by definition — but any
 * absolute path recorded inside it does.
 */
export async function renameGameFolder(
  id: string,
  newName: string
): Promise<{ ok: boolean; error?: string; folder?: string; id?: string }> {
  const game = store.findGame(id)
  if (!game) return { ok: false, error: 'No such game.' }

  const from = game.folder
  const to = path.join(path.dirname(from), newName)
  if (from === to) return { ok: true, folder: from, id }
  if (!fs.existsSync(from)) return { ok: false, error: 'That folder is no longer on disk.' }
  // A case-only rename is fine; anything else must not overwrite a real folder.
  if (fs.existsSync(to) && to.toLowerCase() !== from.toLowerCase()) {
    return { ok: false, error: `There is already a folder called ${newName} beside it.` }
  }

  try {
    await fsp.rename(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const why =
      code === 'EPERM' || code === 'EBUSY'
        ? 'something has a file in it open — close the game or Explorer and try again'
        : (err as Error).message
    return { ok: false, error: `Could not rename the folder: ${why}.` }
  }

  /**
   * Repoints a path that lived inside the old folder. Comparing prefixes as
   * text is not enough: a stored path can use forward slashes while a path
   * built here uses backslashes, and the two would never match. path.relative
   * normalises both, and anything outside the folder — an absolute save
   * location elsewhere, a "{GAMEDIR}" token — comes back untouched.
   */
  const moved = (target: string): string => {
    const relative = path.relative(from, target)
    if (!relative) return to
    if (relative.startsWith('..') || path.isAbsolute(relative)) return target
    return path.join(to, relative)
  }

  const nextId = folderId(to)
  store.updateGame(
    id,
    {
      id: nextId,
      folder: to,
      exePath: game.exePath ? moved(game.exePath) : null,
      exeCandidates: game.exeCandidates.map((c) => ({ ...c, path: moved(c.path) })),
      coverPath: game.coverPath ? moved(game.coverPath) : null,
      savePaths: game.savePaths.map(moved)
    },
    false
  )
  store.save()
  return { ok: true, folder: to, id: nextId }
}
