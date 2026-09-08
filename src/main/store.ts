import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AppState, Game, LibraryRoot, Settings } from '../shared/types'

interface Persisted {
  version: 1
  games: Game[]
  roots: LibraryRoot[]
  settings: Settings
}

const DEFAULT_SETTINGS: Settings = {
  vaultHash: null,
  vaultSalt: null,
  minimizeOnLaunch: false,
  minSessionSeconds: 10,
  steamGridDbKey: null,
  sortBy: 'title',
  syncUrl: null,
  syncToken: null,
  syncUsername: null,
  deviceId: '',
  deviceName: '',
  syncOnPlay: true,
  lastSyncAt: null
}

/**
 * Single JSON document in userData. The library is small (hundreds of games at
 * most) so a database would only add a native dependency for no gain. Writes go
 * through a temp file so a crash mid-write cannot truncate the library.
 */
class Store {
  private file = path.join(app.getPath('userData'), 'library.json')
  private data: Persisted = { version: 1, games: [], roots: [], settings: { ...DEFAULT_SETTINGS } }

  load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Persisted>
      this.data = {
        version: 1,
        games: (parsed.games ?? []).map((g) => ({
          ...g,
          missing: g.missing ?? false,
          // Added with sync; older libraries predate both fields.
          updatedAt: g.updatedAt ?? g.addedAt ?? 0,
          savePaths: g.savePaths ?? [],
          // Added with storage management; null simply means "not measured yet".
          sizeBytes: g.sizeBytes ?? null,
          sizeScannedAt: g.sizeScannedAt ?? null
        })),
        roots: parsed.roots ?? [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') console.error('[store] could not read library, starting fresh:', err)
    }
  }

  save(): void {
    const tmp = `${this.file}.tmp`
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  get filePath(): string {
    return this.file
  }

  // --- games ---------------------------------------------------------------

  get games(): Game[] {
    return this.data.games
  }

  findGame(id: string): Game | undefined {
    return this.data.games.find((g) => g.id === id)
  }

  findGameByFolder(folder: string): Game | undefined {
    const key = folder.toLowerCase()
    return this.data.games.find((g) => g.folder.toLowerCase() === key)
  }

  addGame(game: Game): void {
    this.data.games.push(game)
  }

  /**
   * Edits made through here are user edits, so they stamp the merge clock that
   * sync uses to decide which device's version of a field wins.
   */
  updateGame(id: string, patch: Partial<Game>, touch = true): Game | undefined {
    const game = this.findGame(id)
    if (!game) return undefined
    Object.assign(game, patch)
    if (touch) game.updatedAt = Date.now()
    this.save()
    return game
  }

  removeGame(id: string): void {
    this.data.games = this.data.games.filter((g) => g.id !== id)
    this.save()
  }

  // --- roots ---------------------------------------------------------------

  get roots(): LibraryRoot[] {
    return this.data.roots
  }

  addRoot(folder: string, label?: string): LibraryRoot | null {
    const exists = this.data.roots.some((r) => r.path.toLowerCase() === folder.toLowerCase())
    if (exists) return null
    const root: LibraryRoot = {
      id: randomUUID(),
      path: folder,
      label: label || path.basename(folder) || folder,
      lastScanned: null
    }
    this.data.roots.push(root)
    this.save()
    return root
  }

  removeRoot(id: string, alsoRemoveGames: boolean): void {
    this.data.roots = this.data.roots.filter((r) => r.id !== id)
    if (alsoRemoveGames) this.data.games = this.data.games.filter((g) => g.rootId !== id)
    this.save()
  }

  // --- settings ------------------------------------------------------------

  get settings(): Settings {
    return this.data.settings
  }

  updateSettings(patch: Partial<Settings>): Settings {
    Object.assign(this.data.settings, patch)
    this.save()
    return this.data.settings
  }

  snapshot(): Omit<AppState, 'vault' | 'running'> {
    return { games: this.data.games, roots: this.data.roots, settings: this.data.settings }
  }
}

export const store = new Store()
