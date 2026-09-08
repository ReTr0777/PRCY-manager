import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

/**
 * A save archive. Node ships no zip or tar writer, and a save set is a handful
 * of small files, so this is a gzipped header-plus-payload container rather than
 * a dependency:
 *
 *   PRCYSAVE1 | uint32 header length | JSON header | file bytes back to back
 *
 * Entry paths are slot-relative ("0/profile/save1.dat"), never absolute, so an
 * archive made on one machine restores correctly on another whose save folders
 * live somewhere else entirely.
 */

const MAGIC = Buffer.from('PRCYSAVE1')

export interface ArchiveEntry {
  /** "<slotIndex>/<path within that slot>", always forward slashes. */
  path: string
  size: number
  mtime: number
}

export interface ArchiveHeader {
  createdAt: number
  /** The tokenised save locations this archive was built from. */
  slots: string[]
  entries: ArchiveEntry[]
}

/** Files that are noise in a save folder and only cause false conflicts. */
const IGNORED = new Set(['thumbs.db', 'desktop.ini', '.ds_store'])

async function collect(dir: string, base: string, out: { rel: string; full: string }[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await collect(full, base, out)
    else if (entry.isFile() && !IGNORED.has(entry.name.toLowerCase())) {
      out.push({ rel: path.relative(base, full).split(path.sep).join('/'), full })
    }
  }
}

/**
 * Packs each existing slot directory. A slot that does not exist locally is kept
 * in the header anyway, so restoring on another device still knows about it.
 */
export async function packSlots(slotDirs: string[], slotTokens: string[]): Promise<Buffer> {
  const entries: ArchiveEntry[] = []
  const payloads: Buffer[] = []

  for (const [index, dir] of slotDirs.entries()) {
    const files: { rel: string; full: string }[] = []
    // A slot can be a single file (some games keep one .sav) or a folder.
    try {
      const stat = await fsp.stat(dir)
      if (stat.isFile()) files.push({ rel: path.basename(dir), full: dir })
      else await collect(dir, dir, files)
    } catch {
      continue
    }

    files.sort((a, b) => a.rel.localeCompare(b.rel))
    for (const file of files) {
      const [data, stat] = await Promise.all([fsp.readFile(file.full), fsp.stat(file.full)])
      entries.push({
        path: `${index}/${file.rel}`,
        size: data.length,
        mtime: Math.round(stat.mtimeMs)
      })
      payloads.push(data)
    }
  }

  const header: ArchiveHeader = { createdAt: Date.now(), slots: slotTokens, entries }
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(headerBuf.length)
  return gzipSync(Buffer.concat([MAGIC, length, headerBuf, ...payloads]), { level: 6 })
}

export function readHeader(archive: Buffer): ArchiveHeader {
  const raw = gunzipSync(archive)
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a save archive')
  const length = raw.readUInt32BE(MAGIC.length)
  return JSON.parse(raw.subarray(MAGIC.length + 4, MAGIC.length + 4 + length).toString('utf8'))
}

/** Writes an archive back out into this device's slot directories. */
export async function unpackSlots(archive: Buffer, slotDirs: string[]): Promise<number> {
  const raw = gunzipSync(archive)
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a save archive')
  const headerLength = raw.readUInt32BE(MAGIC.length)
  const header: ArchiveHeader = JSON.parse(
    raw.subarray(MAGIC.length + 4, MAGIC.length + 4 + headerLength).toString('utf8')
  )

  let offset = MAGIC.length + 4 + headerLength
  let written = 0
  for (const entry of header.entries) {
    const data = raw.subarray(offset, offset + entry.size)
    offset += entry.size

    const slash = entry.path.indexOf('/')
    const slotIndex = Number(entry.path.slice(0, slash))
    const relative = entry.path.slice(slash + 1)
    const slotDir = slotDirs[slotIndex]
    // A slot this device has no location for is skipped rather than guessed at.
    if (slotDir === undefined) continue

    const target = path.join(slotDir, ...relative.split('/'))
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, data)
    await fsp.utimes(target, new Date(entry.mtime), new Date(entry.mtime)).catch(() => {})
    written++
  }
  return written
}

/**
 * Identifies the contents of a save set. Built from paths and bytes only — not
 * timestamps — so re-packing unchanged saves produces the same hash and does not
 * look like a change worth syncing.
 */
export function contentHash(archive: Buffer): string {
  const raw = gunzipSync(archive)
  const headerLength = raw.readUInt32BE(MAGIC.length)
  const header: ArchiveHeader = JSON.parse(
    raw.subarray(MAGIC.length + 4, MAGIC.length + 4 + headerLength).toString('utf8')
  )
  const hash = createHash('sha256')
  for (const entry of header.entries) hash.update(`${entry.path}:${entry.size}\n`)
  hash.update(raw.subarray(MAGIC.length + 4 + headerLength))
  return hash.digest('hex')
}
