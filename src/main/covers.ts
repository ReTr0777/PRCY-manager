import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { store } from './store'
import type { CoverCandidate, CoverFetchReport } from '../shared/types'

const UA = 'PRCYManager/0.1 (personal game library manager)'
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
/** Keep bulk fetches to roughly one call a second rather than hammering the store. */
const POLITE_DELAY_MS = 800

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function coversDir(): string {
  const dir = path.join(app.getPath('userData'), 'covers')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// --- Steam -------------------------------------------------------------------

const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps'

/**
 * Steam's own store search needs no key, and its art lives at predictable paths
 * per appid. steamdb.info is a third-party mirror sitting behind Cloudflare, so
 * this goes to the source instead.
 *
 * Both shapes are offered: the portrait library capsule most stores use, and the
 * landscape header. Not every app has a portrait one, and the picker drops any
 * tile whose image fails to load rather than paying for a check up front.
 */
async function searchSteam(query: string): Promise<CoverCandidate[]> {
  let items: { id: number; name: string }[]
  try {
    const res = await fetch(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&cc=us&l=en`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    )
    if (!res.ok) return []
    items = ((await res.json()) as { items?: { id: number; name: string }[] }).items ?? []
  } catch {
    return []
  }

  const out: CoverCandidate[] = []
  for (const item of items.slice(0, 6)) {
    out.push({
      source: 'Steam',
      title: item.name,
      thumbUrl: `${STEAM_CDN}/${item.id}/library_600x900.jpg`,
      fullUrl: `${STEAM_CDN}/${item.id}/library_600x900_2x.jpg`,
      width: 600,
      height: 900
    })
    out.push({
      source: 'Steam',
      title: item.name,
      thumbUrl: `${STEAM_CDN}/${item.id}/header.jpg`,
      fullUrl: `${STEAM_CDN}/${item.id}/capsule_616x353.jpg`,
      width: 616,
      height: 353
    })
  }
  return out
}

// --- SteamGridDB -------------------------------------------------------------

async function searchSteamGridDb(query: string, key: string): Promise<CoverCandidate[]> {
  const headers = { 'User-Agent': UA, Authorization: `Bearer ${key}` }
  try {
    const found = await fetch(
      `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(query)}`,
      { headers }
    )
    if (!found.ok) return []
    const games = ((await found.json()) as { data?: { id: number; name: string }[] }).data ?? []

    const out: CoverCandidate[] = []
    for (const game of games.slice(0, 2)) {
      const grids = await fetch(
        `https://www.steamgriddb.com/api/v2/grids/game/${game.id}?dimensions=600x900,342x482&types=static`,
        { headers }
      )
      if (!grids.ok) continue
      const items =
        ((await grids.json()) as { data?: { url: string; thumb: string; width: number; height: number }[] })
          .data ?? []
      for (const item of items.slice(0, 6)) {
        out.push({
          source: 'SteamGridDB',
          title: game.name,
          thumbUrl: item.thumb,
          fullUrl: item.url,
          width: item.width,
          height: item.height
        })
      }
    }
    return out
  } catch {
    return []
  }
}

// --- matching ----------------------------------------------------------------

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** 0..1. Used to decide whether a bulk fetch may apply a result unattended. */
export function titleSimilarity(a: string, b: string): number {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const [short, long] = x.length < y.length ? [x, y] : [y, x]
  if (long.includes(short)) return short.length / long.length
  return 0
}

// --- public API --------------------------------------------------------------

/** Tiebreak between equally well-matching titles: official art first. */
const SOURCE_RANK: Record<CoverCandidate['source'], number> = { Steam: 0, SteamGridDB: 1 }

export async function searchCovers(query: string): Promise<CoverCandidate[]> {
  const key = store.settings.steamGridDbKey
  const results = await Promise.all([
    searchSteam(query),
    key ? searchSteamGridDb(query, key) : Promise.resolve<CoverCandidate[]>([])
  ])
  // Rank by how well the result's own title matches what was asked for.
  return results
    .flat()
    .map((c) => ({ c, score: titleSimilarity(query, c.title) }))
    .sort((a, b) => b.score - a.score || SOURCE_RANK[a.c.source] - SOURCE_RANK[b.c.source])
    .map(({ c }) => c)
    .slice(0, 30)
}

async function download(url: string, gameId: string): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA } })
  } catch {
    return null
  }
  if (!res.ok) return null

  const type = res.headers.get('content-type') ?? ''
  if (!type.startsWith('image/')) return null
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null

  const ext = type.includes('png')
    ? '.png'
    : type.includes('webp')
      ? '.webp'
      : type.includes('gif')
        ? '.gif'
        : '.jpg'
  const stamp = createHash('sha1').update(url).digest('hex').slice(0, 8)
  const file = path.join(coversDir(), `${gameId}-${stamp}${ext}`)
  await fsp.writeFile(file, buffer)
  return file
}

/** Downloads one candidate and points the game at it, cleaning up the old file. */
export async function applyCover(gameId: string, candidate: CoverCandidate): Promise<string | null> {
  const game = store.findGame(gameId)
  if (!game) return null

  const attempts = [candidate.fullUrl, candidate.thumbUrl]
  // Some Steam apps have no portrait capsule; the header always exists.
  if (candidate.source === 'Steam') attempts.push(candidate.thumbUrl.replace(/\/[^/]+$/, '/header.jpg'))

  let file: string | null = null
  for (const attempt of attempts) {
    file = await download(attempt, gameId)
    if (file) break
  }
  if (!file) return null

  const previous = game.coverPath
  game.coverPath = file
  // Applying art from the picker is a choice, and choices travel between
  // devices; a picture the scanner found in a folder does not.
  game.coverChosen = true
  game.updatedAt = Date.now()
  store.save()

  // Only ever delete files this app downloaded, never art inside a game folder.
  if (previous && previous !== file && path.dirname(previous) === coversDir()) {
    await fsp.rm(previous, { force: true })
  }
  return file
}

/**
 * Fills in art for every game that has none. Only confident title matches are
 * applied, so a bulk run cannot quietly attach the wrong cover to a game.
 */
export async function fetchMissingCovers(
  onProgress?: (done: number, total: number, title: string) => void
): Promise<CoverFetchReport> {
  const targets = store.games.filter((g) => !g.coverPath && !g.missing)
  const report: CoverFetchReport = { updated: 0, skipped: 0, failed: 0 }

  for (const [index, game] of targets.entries()) {
    onProgress?.(index + 1, targets.length, game.title)
    const candidates = await searchCovers(game.title)
    const best = candidates.find((c) => titleSimilarity(game.title, c.title) >= 0.72)
    if (!best) {
      report.skipped++
    } else if (await applyCover(game.id, best)) {
      report.updated++
    } else {
      report.failed++
    }
    if (index < targets.length - 1) await sleep(POLITE_DELAY_MS)
  }
  return report
}
