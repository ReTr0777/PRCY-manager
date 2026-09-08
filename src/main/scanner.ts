import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { store } from './store'
import type { ExeCandidate, Game, ScanReport } from '../shared/types'

/** Folders that never contain the game itself. */
const JUNK_DIRS = new Set([
  '_commonredist', 'commonredist', 'redist', 'directx', 'dotnet', 'vcredist',
  'installers', 'node_modules', '.git', 'locales', 'resources', 'mono', 'tools',
  'thirdparty', 'monobleedingedge', 'crashreportclient', 'saves', 'savegames'
])

/** Executables that ship alongside a game but are never the thing to launch. */
const JUNK_EXE = [
  'unins', 'uninstall', 'setup', 'install', 'vcredist', 'dxsetup', 'dotnetfx',
  'crashreport', 'crashhandler', 'crashpad', 'ue4prereq', 'ueprereq', 'notification_helper',
  'unitycrashhandler', 'zsync', 'python', 'ffmpeg', 'node', 'quicksfv', 'onlinefix',
  'steam_api', 'steamclient', 'oalinst', 'epicwebhelper', 'dxwebsetup', 'directx'
]

const RUNNABLE = ['.exe', '.bat', '.cmd', '.lnk', '.jar', '.swf', '.html']

/**
 * Folder names that are never a game in their own right: support packages, and
 * the engine payload directories that end up beside a game when an archive was
 * extracted into the library root instead of its own folder.
 */
const NON_GAME_NAMES = new Set([
  '_commonredist', 'commonredist', 'redist', 'redists', 'redistributables', 'directx', 'dotnet',
  'vcredist', 'install', 'installer', 'installers', 'setup', 'workshop', 'engine', 'binaries',
  'content', 'plugins', 'saves', 'savegame', 'savegames', 'docs', 'documentation', 'crack',
  'cracks', 'patch', 'patches', 'update', 'updates', 'dlc', 'mods', 'tools', 'bin', 'data',
  'temp', 'games', 'new folder'
])

/** Repack installers: the folder holds a setup program, not a playable game. */
const REPACK_PATTERNS = [
  /\b(fitgirl|dodi|elamigos|xatab|kaoskrew|masquerade|corepack)\b/i,
  /\brepack\b/i,
  /\b(setup|installer|install[-_. ]?files)\b/i
]

/** Online fixes, emulators and crack packages, which ship as their own folder. */
const NON_GAME_PATTERNS = [
  /online[-_. ]?fix/i,
  /fix[-_. ]?repair/i,
  /(steam|epic|goldberg|smartsteam|creamapi|greenluma|uplay|origin)[-_. ]?(emu|emulator|fix|crack|unlocker)/i,
  /\b(cracked|nodvd|no[-_. ]?cd|codex[-_. ]?fix)\b/i,
  /_fix_.*generic/i,
  /\bfix\b.*\bgeneric\b/i
]

/**
 * Why this folder is not a game, or null if it looks like one. Runs on the
 * direct children of a library root only — adding a folder by hand bypasses it,
 * so a false positive is never a dead end.
 */
export function nonGameReason(
  folderName: string,
  hasRunnable: boolean,
  subdirs: string[],
  siblings: Set<string>
): string | null {
  const name = folderName.toLowerCase().trim()
  const dirs = subdirs.map((d) => d.toLowerCase())

  if (NON_GAME_PATTERNS.some((re) => re.test(folderName))) return 'fix or crack package'
  if (REPACK_PATTERNS.some((re) => re.test(folderName))) return 'installer or repack'
  if (NON_GAME_NAMES.has(name)) return 'support folder'
  // Unity writes "<Game>_Data" next to the executable.
  if (/_data$/i.test(name)) return 'engine data folder'
  // An Unreal project directory looks like a game folder on its own, so it only
  // counts as leftovers when an Engine folder was extracted beside it.
  if (dirs.includes('binaries') && dirs.includes('content') && siblings.has('engine')) {
    return 'engine payload folder'
  }
  // Nothing to launch: a photo folder, a documents folder, an empty download, or
  // an installer whose only program is a setup stub.
  if (!hasRunnable) return 'nothing runnable inside'
  return null
}

const COVER_NAMES = ['cover', 'folder', 'capsule', 'header', 'thumbnail', 'banner', 'icon', 'poster']
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

/** Stable per-folder id. Hashed, so two folders never collide on a shared prefix. */
export const gameId = (folder: string): string =>
  createHash('sha1').update(folder.toLowerCase()).digest('hex').slice(0, 16)

/**
 * Trailing tokens itch.io builds tend to carry. Stripped before separators are
 * normalised, since "v1.2" is only recognisable while the dots are still there.
 */
/** Release group or site the download came from. */
const GROUP_SUFFIX =
  /[-_. ]+(ofme|tenoke|rune|codex|empress|skidrow|flt|doge|plaza|cpy|hoodlum|razor1911|tinyiso|p2p|gog|steamrip(\.com)?|fitgirl|dodi|multi\d+)$/i

const SUFFIXES = [
  /[-_. ]+[([]?(win(dows)?[-_. ]?(32|64)?|x64|x86|pc|linux|mac|osx|32bit|64bit)[)\]]?$/i,
  // Trailing version, optionally with a word glued on: "v1.2", "0.33.0.2free".
  /[-_. ]+[([]?v?\d+([._]\d+)+[a-z]{0,8}[)\]]?$/i,
  GROUP_SUFFIX,
  // "Hotfix 2", "Build 12345", "Update 3".
  /[-_. ]+(hotfix|patch|update|build|rev)[-_. ]*\d*$/i
]

/** Store codes some downloads are named after: DLsite's RJ/VJ/BJ, DMM's d_. */
const STORE_CODE = /^(rj|vj|bj|rg|ve)\d{5,}[-_. ]*/i

/** "Some_Game.v1.2-win64" -> "Some Game" */
export function prettifyTitle(folderName: string): string {
  let t = folderName.trim().replace(STORE_CODE, '')
  if (!t) t = folderName.trim()
  for (let pass = 0; pass < 4; pass++) {
    const before = t
    for (const suffix of SUFFIXES) t = t.replace(suffix, '')
    if (t === before) break
  }
  t = t.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) t = folderName
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function scoreExe(exePath: string, size: number, gameFolder: string, folderName: string): number {
  const base = path.basename(exePath, path.extname(exePath)).toLowerCase()
  const ext = path.extname(exePath).toLowerCase()
  const depth = path.relative(gameFolder, exePath).split(path.sep).length - 1
  let score = 100

  if (JUNK_EXE.some((j) => base.includes(j))) score -= 200
  // Sitting right in the game folder is the usual case.
  score -= depth * 15
  // A name resembling the folder name is a strong signal.
  const norm = (s: string): string => s.replace(/[^a-z0-9]/g, '')
  const folderNorm = norm(folderName.toLowerCase())
  const baseNorm = norm(base)
  if (folderNorm && baseNorm && (folderNorm.includes(baseNorm) || baseNorm.includes(folderNorm))) score += 60
  if (base === 'game' || base === 'start' || base === 'play' || base === 'launcher') score += 25
  if (ext === '.exe') score += 20
  else if (ext === '.bat' || ext === '.cmd') score += 5
  else score -= 10
  // Bigger binaries are usually the engine rather than a helper.
  score += Math.min(30, Math.round(size / (1024 * 1024)))
  return score
}

/** Depth 5 covers "<Wrapper>/<Game>/<Project>/Binaries/Win64/game.exe". */
async function findRunnables(
  dir: string,
  gameFolder: string,
  depth: number,
  out: ExeCandidate[]
): Promise<void> {
  if (depth > 5 || out.length > 200) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const folderName = path.basename(gameFolder)
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (JUNK_DIRS.has(entry.name.toLowerCase())) continue
      await findRunnables(full, gameFolder, depth + 1, out)
    } else if (RUNNABLE.includes(path.extname(entry.name).toLowerCase())) {
      let size = 0
      try {
        size = (await fs.stat(full)).size
      } catch {
        continue
      }
      out.push({ path: full, size, score: scoreExe(full, size, gameFolder, folderName) })
    }
  }
}

async function findCover(gameFolder: string): Promise<string | null> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(gameFolder, { withFileTypes: true })
  } catch {
    return null
  }
  const images = entries
    .filter((e) => e.isFile() && IMAGE_EXT.includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
  if (images.length === 0) return null
  const named = images.find((n) =>
    COVER_NAMES.includes(path.basename(n, path.extname(n)).toLowerCase())
  )
  return path.join(gameFolder, named ?? images[0])
}

/** Inspect one game folder and produce the fields a scan can determine. */
export async function inspectFolder(gameFolder: string): Promise<{
  exeCandidates: ExeCandidate[]
  exePath: string | null
  coverPath: string | null
}> {
  const candidates: ExeCandidate[] = []
  await findRunnables(gameFolder, gameFolder, 0, candidates)
  candidates.sort((a, b) => b.score - a.score)
  const top = candidates.slice(0, 25)
  return {
    exeCandidates: top,
    exePath: top.length > 0 && top[0].score > -100 ? top[0].path : null,
    coverPath: await findCover(gameFolder)
  }
}

/** Files that say nothing about whether a folder is a game or just a container. */
const TRIVIAL_FILE_EXT = [
  '.txt', '.url', '.nfo', '.md', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.log'
]

/** An Unreal project directory, which is part of a game rather than a game. */
function isEnginePayload(name: string, subdirs: string[]): boolean {
  const dirs = subdirs.map((d) => d.toLowerCase())
  if (JUNK_DIRS.has(name.toLowerCase()) || NON_GAME_NAMES.has(name.toLowerCase())) return true
  return dirs.includes('binaries') && dirs.includes('content')
}

/**
 * Resolves what a root child actually contains. A downloaded game is often
 * wrapped in a folder of its own name (double-extracted zip), and people keep
 * several games together inside one folder. Both cases would otherwise be titled
 * after the outer folder instead of the game.
 *
 * Returns the folders to treat as games — usually just the one passed in.
 */
async function resolveGameFolders(folder: string, depth = 0): Promise<string[]> {
  if (depth >= 3) return [folder]

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(folder, { withFileTypes: true })
  } catch {
    return [folder]
  }

  // Real content of its own means this folder is the game, not a container.
  const hasOwnContent = entries.some(
    (e) => e.isFile() && !TRIVIAL_FILE_EXT.includes(path.extname(e.name).toLowerCase())
  )
  if (hasOwnContent) return [folder]

  const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  const candidates = subdirs.filter((name) => !isEnginePayload(name, []))

  const inner: string[] = []
  for (const name of candidates) {
    const child = path.join(folder, name)
    let childDirs: string[] = []
    try {
      childDirs = (await fs.readdir(child, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    if (isEnginePayload(name, childDirs)) continue
    const info = await inspectFolder(child)
    if (info.exePath) inner.push(...(await resolveGameFolders(child, depth + 1)))
  }

  return inner.length > 0 ? inner : [folder]
}

/**
 * Two copies of one game — a different build, or the same download kept twice —
 * are both real, so neither is dropped. Instead they get told apart by whatever
 * distinguishes them on disk: the version in the folder name, or the folder they
 * were downloaded into.
 *
 * Only titles still matching what the scanner generated are touched, so a name
 * typed by hand is never rewritten.
 */
function disambiguateTitles(): void {
  const byTitle = new Map<string, Game[]>()
  for (const game of store.games) {
    const key = game.title.toLowerCase()
    const bucket = byTitle.get(key)
    if (bucket) bucket.push(game)
    else byTitle.set(key, [game])
  }

  for (const [, group] of byTitle) {
    if (group.length < 2) continue

    for (const game of group) {
      if (game.title !== prettifyTitle(path.basename(game.folder))) continue

      const root = store.roots.find((r) => r.id === game.rootId)
      const parent = path.dirname(game.folder)
      // What the copy sat in: its own folder when it is a root child, otherwise
      // the wrapper or container folder it was found inside.
      const context =
        root && parent.toLowerCase() === root.path.toLowerCase()
          ? path.basename(game.folder)
          : path.basename(parent)

      // Keep the version readable here — it is usually the whole difference —
      // so dots survive between digits and nowhere else.
      let qualifier = context
        .replace(GROUP_SUFFIX, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\.(?![0-9])|(?<![0-9])\./g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (norm(qualifier).startsWith(norm(game.title))) {
        qualifier = qualifier.slice(game.title.length).replace(/^[-_. ]+/, '').trim()
      }
      if (qualifier) game.title = `${game.title} (${qualifier})`
    }
  }
}

/**
 * Whether the user put something into this entry that could not be recreated.
 * The vault flag is deliberately not counted: it moves to the games that replace
 * a folder, so it never has to keep a stale entry alive.
 */
function hasInvestment(game: Game): boolean {
  return (
    game.playtimeSeconds > 0 ||
    game.lastPlayed !== null ||
    game.favorite ||
    game.tags.length > 0 ||
    game.notes !== ''
  )
}

/**
 * Moves what the user set on a folder onto the game that now represents it,
 * which happens when a wrapper folder turns out to hold the real game. Fields
 * the successor already has of its own are left alone.
 */
function inheritFrom(previous: Game, successor: Game, sole: boolean): void {
  // Staying hidden matters even when a folder became several games.
  if (previous.hidden) successor.hidden = true
  if (!sole) return

  if (previous.favorite) successor.favorite = true
  if (successor.tags.length === 0) successor.tags = previous.tags
  if (successor.notes === '') successor.notes = previous.notes
  successor.playtimeSeconds += previous.playtimeSeconds
  if (previous.lastPlayed && (!successor.lastPlayed || previous.lastPlayed > successor.lastPlayed)) {
    successor.lastPlayed = previous.lastPlayed
  }
  if (!successor.coverPath) successor.coverPath = previous.coverPath
  // A title typed by hand outranks anything generated from a folder name. The
  // trailing "(…)" a duplicate gets is generated too, so it does not count.
  const auto = prettifyTitle(path.basename(previous.folder))
  const withoutQualifier = previous.title.replace(/\s*\([^)]*\)\s*$/, '')
  if (previous.title !== auto && withoutQualifier !== auto) successor.title = previous.title
}

/**
 * Walk every configured root. Roots that are offline (unplugged drive, network
 * share) are reported as skipped rather than marking their games missing.
 */
export async function scanAll(onProgress?: (msg: string) => void): Promise<ScanReport> {
  const report: ScanReport = {
    added: 0,
    updated: 0,
    missing: 0,
    ignored: 0,
    ignoredNames: [],
    skippedRoots: []
  }
  const seenFolders = new Set<string>()

  for (const root of store.roots) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(root.path, { withFileTypes: true })
    } catch {
      report.skippedRoots.push(root.label)
      continue
    }

    // A folder's siblings tell an Unreal project directory apart from a game.
    const siblings = new Set(
      entries.filter((e) => e.isDirectory()).map((e) => e.name.toLowerCase())
    )

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const folder = path.join(root.path, entry.name)
      seenFolders.add(folder.toLowerCase())
      onProgress?.(entry.name)

      const outer = store.findGameByFolder(folder)
      const outerInfo = await inspectFolder(folder)

      let subdirs: string[] = []
      try {
        subdirs = (await fs.readdir(folder, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        // Unreadable folder: treat as having no subdirectories.
      }
      const reason = nonGameReason(entry.name, outerInfo.exePath !== null, subdirs, siblings)
      if (reason) {
        // Drop a previously detected entry only when nothing would be lost.
        if (outer && !hasInvestment(outer)) store.removeGame(outer.id)
        report.ignored++
        if (report.ignoredNames.length < 40) report.ignoredNames.push(entry.name)
        continue
      }

      // One folder can hold several games, or wrap a single one in its own name.
      const gameFolders = await resolveGameFolders(folder)
      const expanded = gameFolders.length !== 1 || gameFolders[0] !== folder

      // The outer folder turned out to be a container, so its entry is not a
      // game any more. Retire it and pass what it carried to its replacements,
      // rather than leaving it beside them as a duplicate.
      let legacy: Game | null = null
      if (expanded && outer) {
        if (gameFolders.length === 1 || !hasInvestment(outer)) {
          legacy = { ...outer }
          store.removeGame(outer.id)
        } else {
          seenFolders.add(folder.toLowerCase())
        }
      }

      for (const gameFolder of gameFolders) {
        seenFolders.add(gameFolder.toLowerCase())
        const existing = store.findGameByFolder(gameFolder)
        const info = gameFolder === folder ? outerInfo : await inspectFolder(gameFolder)

        if (existing) {
          existing.exeCandidates = info.exeCandidates
          existing.missing = false
          existing.rootId = root.id
          // Never overwrite a choice the user made by hand.
          if (!existing.exePath || !info.exeCandidates.some((c) => c.path === existing.exePath)) {
            existing.exePath = info.exePath
          }
          if (!existing.coverPath) existing.coverPath = info.coverPath
          if (legacy) inheritFrom(legacy, existing, gameFolders.length === 1)
          report.updated++
        } else {
          const game: Game = {
            id: gameId(gameFolder),
            // Name it after the folder the game actually lives in, which is not
            // the root child when that was a wrapper or a container.
            title: prettifyTitle(path.basename(gameFolder)),
            folder: gameFolder,
            rootId: root.id,
            exePath: info.exePath,
            exeCandidates: info.exeCandidates,
            coverPath: info.coverPath,
            coverChosen: false,
            hidden: false,
            favorite: false,
            tags: [],
            notes: '',
            playtimeSeconds: 0,
            lastPlayed: null,
            addedAt: Date.now(),
            missing: false,
            updatedAt: Date.now(),
            savePaths: [],
            sizeBytes: null,
            sizeScannedAt: null
          }
          if (legacy) inheritFrom(legacy, game, gameFolders.length === 1)
          store.addGame(game)
          report.added++
        }
      }
    }
    root.lastScanned = Date.now()
  }

  const liveRootIds = new Set(
    store.roots.filter((r) => !report.skippedRoots.includes(r.label)).map((r) => r.id)
  )
  for (const game of store.games) {
    if (!liveRootIds.has(game.rootId)) continue
    const gone = !seenFolders.has(game.folder.toLowerCase())
    if (gone !== game.missing) game.missing = gone
    if (gone) report.missing++
  }

  disambiguateTitles()
  store.save()
  return report
}
