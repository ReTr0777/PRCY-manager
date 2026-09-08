/** Types shared between the main process, the preload bridge and the renderer. */

export interface LibraryRoot {
  id: string
  /** Absolute path to a folder whose direct subfolders are each one game. */
  path: string
  /** Friendly name, e.g. "Itch downloads (D:)". */
  label: string
  /** Roots on removable/network drives may be offline; scans skip them silently. */
  lastScanned: number | null
}

export interface ExeCandidate {
  path: string
  /** Bytes. Used both for display and for ranking the best guess. */
  size: number
  /** Higher is a more likely "the game" executable. */
  score: number
}

export interface Game {
  id: string
  title: string
  /** Absolute path to the game's own folder. */
  folder: string
  rootId: string
  /** Chosen executable, absolute. Null when nothing runnable was found. */
  exePath: string | null
  exeCandidates: ExeCandidate[]
  /** Absolute path to a cover image on disk, or null for the generated tile. */
  coverPath: string | null
  hidden: boolean
  favorite: boolean
  tags: string[]
  notes: string
  /** Time played on this device. Other devices' time is added in on sync. */
  playtimeSeconds: number
  lastPlayed: number | null
  addedAt: number
  /** Set when the folder disappeared from disk on the last scan. */
  missing: boolean
  /** Last time the user changed something here; decides who wins a sync merge. */
  updatedAt: number
  /** Tokenised save locations, e.g. "{APPDATA}/RenPy/Game". */
  savePaths: string[]
  /** Folder size on this device's disk; null until measured. Never synced. */
  sizeBytes: number | null
  sizeScannedAt: number | null
  /** Playtime reported by other devices, keyed by device id. */
  remotePlaytime?: Record<string, number>
  /** What this device last exchanged with the server, to spot local changes. */
  sync?: GameSyncState
}

export interface GameSyncState {
  /** Content hash of the saves as of the last successful sync. */
  saveHash: string | null
  /** Server version id matching that hash. */
  versionId: string | null
  syncedAt: number | null
}

export interface SaveLocation {
  /** Tokenised path. */
  path: string
  /** Where the guess came from, e.g. "Ren'Py", "game folder". */
  source: string
}

export interface Settings {
  /** PBKDF2 hash of the vault password; null means no vault has been set up. */
  vaultHash: string | null
  vaultSalt: string | null
  /** Minimise the window while a game is running. */
  minimizeOnLaunch: boolean
  /** Sessions shorter than this are discarded as mis-launches. */
  minSessionSeconds: number
  /** Optional key from steamgriddb.com; unlocks the second cover-art source. */
  steamGridDbKey: string | null
  sortBy: 'title' | 'lastPlayed' | 'playtime' | 'addedAt' | 'size'

  /** Base URL of your sync server, e.g. "http://tower.local:8787". */
  syncUrl: string | null
  /** Device token issued by the server at sign-in; not a password. */
  syncToken: string | null
  /** Account this device is signed in as, for display. */
  syncUsername: string | null
  /** Stable id for this machine, generated once. */
  deviceId: string
  /** What this device calls itself in conflict prompts. */
  deviceName: string
  /** Sync saves automatically when a game starts and when it closes. */
  syncOnPlay: boolean
  lastSyncAt: number | null
}

export interface SyncResult {
  ok: boolean
  error?: string
  /** Games whose metadata changed in either direction. */
  metadataChanged: number
  savesUploaded: number
  savesDownloaded: number
  coversUploaded: number
  coversDownloaded: number
  /** Games needing a decision before their saves can sync. */
  conflicts: SaveConflict[]
  /** Games that look like another device's copy under a slightly different name. */
  suggestions: TitleSuggestion[]
}

/**
 * A local game whose title nearly matches one already on the server. Sync pairs
 * games by title, so these two would stay separate until one side is renamed.
 */
export interface TitleSuggestion {
  gameId: string
  localTitle: string
  localFolder: string
  remoteTitle: string
  /** The device that last wrote the other entry, so the prompt can name it. */
  remoteDevice: string | null
  /** 0..1, how alike the two titles are. */
  similarity: number
  /** True when the other side has saves waiting, which is the real prize. */
  remoteHasSave: boolean
  /** The folder could be renamed to this; null when the name is unusable. */
  folderRenameTo: string | null
}

export interface SaveConflict {
  gameId: string
  gameKey: string
  title: string
  local: SaveSide
  remote: SaveSide
  /** Per-file comparison, newest first and capped. */
  files: SaveFileDiff[]
  /** Files beyond the ones listed. */
  moreFiles: number
}

/** One side of a save conflict, described well enough to choose between them. */
export interface SaveSide {
  /** When the archive was assembled. */
  capturedAt: number
  /** Newest modification time among the files — how recent the progress is. */
  newestFileAt: number
  fileCount: number
  /** Total bytes of the files themselves, not the compressed archive. */
  size: number
  deviceName: string
  versionId?: string
}

export interface SaveFileDiff {
  /** Path within the save location, e.g. "slot 1 · profile/save1.dat". */
  path: string
  local: { size: number; mtime: number } | null
  remote: { size: number; mtime: number } | null
}

/** A desktop build published to your sync server. */
export interface AppRelease {
  version: string
  notes: string
  size: number
  sha256: string
  publishedAt: number
}

export interface AppUpdateStatus {
  /** The version running right now. */
  current: string
  /** Null when there is nothing newer, or nothing published at all. */
  available: AppRelease | null
  /** Set when the server's build is older than this one — usually a mistake. */
  behind?: string
  error?: string
}

/** What a sync server says about itself before you sign in. */
export interface SyncServerInfo {
  ok: boolean
  error?: string
  /** False for a server predating accounts. */
  accounts?: boolean
  /** Whether an invite code will be accepted for a new account. */
  registrationOpen?: boolean
  /** Largest body the server takes in one request; bigger uploads are chunked. */
  maxBodyBytes?: number
}

export interface SyncAccount {
  username: string
  userId: string
  deviceName: string
}

export interface SyncDevice {
  id: string
  deviceName: string
  createdAt: number
  lastSeen: number
  current: boolean
}

/** One stored version of a game's saves, as kept on the server. */
export interface SaveVersion {
  versionId: string
  hash: string
  deviceId: string
  deviceName: string
  /** Compressed size of the archive. */
  size: number
  capturedAt: number
  /** True for the version this device currently holds. */
  current: boolean
}

/** What happened when a game was prepared for launch. */
export interface LaunchPrep {
  ok: boolean
  error?: string
  /** Set when a newer save was pulled down before starting. */
  pulledFrom?: string
  /** Set when both sides changed and the user has to choose first. */
  conflict?: SaveConflict
}

/** How the user resolved one conflict. */
export type ConflictChoice = 'local' | 'remote' | 'skip'

export interface SyncProgress {
  phase: 'metadata' | 'saves' | 'covers' | 'done'
  message: string
}

/** One drive that holds part of the library, as it stands on this device. */
export interface DriveUsage {
  /** Filesystem root, e.g. "D:\\". */
  drive: string
  label: string
  /** False when the drive is unplugged or a share is not answering. */
  online: boolean
  totalBytes: number
  freeBytes: number
  /** Total of the games here whose size is known. */
  gameBytes: number
  gameCount: number
  measuredCount: number
}

export interface AppStorageUsage {
  userDataPath: string
  libraryBytes: number
  coverBytes: number
  coverCount: number
  backupBytes: number
  backupCount: number
}

export interface StorageReport {
  drives: DriveUsage[]
  app: AppStorageUsage
  /** Games still without a measured size, so totals are never overstated. */
  unmeasured: number
  generatedAt: number
}

export interface ScanReport {
  added: number
  updated: number
  missing: number
  /** Folders skipped as fixes, installers, engine payloads or other non-games. */
  ignored: number
  /** Names of the skipped folders, capped, so a wrong guess stays visible. */
  ignoredNames: string[]
  skippedRoots: string[]
}

export interface CoverCandidate {
  source: 'Steam' | 'SteamGridDB'
  title: string
  /** Small preview shown in the picker. */
  thumbUrl: string
  /** Best available version; falls back to thumbUrl when it does not exist. */
  fullUrl: string
  pageUrl?: string
  width?: number
  height?: number
}

export interface CoverFetchReport {
  updated: number
  /** No result was a confident enough title match to apply unattended. */
  skipped: number
  failed: number
}

export interface RunningGame {
  gameId: string
  startedAt: number
  pid: number
}

export type VaultState = 'unset' | 'locked' | 'unlocked'

export interface AppState {
  games: Game[]
  roots: LibraryRoot[]
  settings: Settings
  vault: VaultState
  running: RunningGame[]
}
