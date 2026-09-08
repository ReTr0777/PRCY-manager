import { app, shell } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { store } from './store'
import type { AppRelease, AppUpdateStatus } from '../shared/types'

/**
 * Updates the desktop app from your own sync server.
 *
 * The server is the natural place for this: every device that syncs is already
 * signed in to it and can reach it, and nothing here has to be public. Builds
 * are put there with `npm run publish`.
 */

function updateDir(): string {
  const dir = path.join(app.getPath('userData'), 'updates')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Compares "0.2.0" with "0.10.1" numerically rather than as text. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): number[] => v.split('-')[0].split('.').map((n) => Number(n) || 0)
  const [a, b] = [parse(candidate), parse(current)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

async function serverCall(route: string): Promise<Response | null> {
  const { syncUrl, syncToken } = store.settings
  if (!syncUrl || !syncToken) return null
  try {
    return await fetch(`${syncUrl.replace(/\/+$/, '')}${route}`, {
      headers: { Authorization: `Bearer ${syncToken}` }
    })
  } catch {
    return null
  }
}

export async function checkForUpdate(): Promise<AppUpdateStatus> {
  const current = app.getVersion()
  if (!store.settings.syncUrl || !store.settings.syncToken) {
    return { current, available: null, error: 'Sign in to your sync server to get updates.' }
  }

  const response = await serverCall('/v1/app/latest')
  if (!response) return { current, available: null, error: 'Could not reach the sync server.' }
  if (response.status === 404) return { current, available: null }
  if (!response.ok) return { current, available: null, error: 'The server rejected the request.' }

  const release = (await response.json()) as AppRelease
  return {
    current,
    available: isNewer(release.version, current) ? release : null,
    // Worth surfacing: a downgrade usually means someone published the wrong file.
    behind: !isNewer(release.version, current) && release.version !== current ? release.version : undefined
  }
}

/**
 * Downloads the installer, checks it against the hash the server computed, and
 * keeps it. A file that does not match is deleted rather than run — that check
 * is the only thing standing in for a code signature here.
 */
export async function downloadUpdate(
  version: string,
  onProgress?: (received: number, total: number) => void
): Promise<{ ok: boolean; error?: string; file?: string }> {
  const latest = await serverCall('/v1/app/latest')
  if (!latest || !latest.ok) return { ok: false, error: 'Could not read the release details.' }
  const release = (await latest.json()) as AppRelease
  if (release.version !== version) {
    return { ok: false, error: 'The published build changed — check again.' }
  }

  const target = path.join(updateDir(), `PRCY-Manager-${version}.exe`)
  // A finished download from an earlier attempt is worth reusing.
  if (fs.existsSync(target)) {
    const existing = createHash('sha256').update(await fsp.readFile(target)).digest('hex')
    if (existing === release.sha256) return { ok: true, file: target }
    await fsp.rm(target, { force: true })
  }

  const response = await serverCall(`/v1/app/download/${version}`)
  if (!response || !response.ok || !response.body) {
    return { ok: false, error: 'Could not download the installer.' }
  }

  const total = Number(response.headers.get('content-length')) || release.size
  const chunks: Buffer[] = []
  let received = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    received += value.length
    onProgress?.(received, total)
  }

  const data = Buffer.concat(chunks)
  const hash = createHash('sha256').update(data).digest('hex')
  if (hash !== release.sha256) {
    return { ok: false, error: 'The download did not match its checksum, so it was discarded.' }
  }

  await fsp.writeFile(target, data)
  // Only the last two are worth keeping around.
  const mine = (await fsp.readdir(updateDir())).filter((n) => n.endsWith('.exe')).sort()
  for (const old of mine.slice(0, Math.max(0, mine.length - 2))) {
    await fsp.rm(path.join(updateDir(), old), { force: true })
  }
  return { ok: true, file: target }
}

/**
 * Hands the installer to Windows and gets out of its way. The installer cannot
 * replace files this process has open, so the app has to quit for it to work.
 */
export async function installUpdate(file: string): Promise<{ ok: boolean; error?: string }> {
  if (!fs.existsSync(file)) return { ok: false, error: 'That installer is no longer on disk.' }
  const failure = await shell.openPath(file)
  if (failure) return { ok: false, error: failure }
  setTimeout(() => app.quit(), 1200)
  return { ok: true }
}
