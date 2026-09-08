import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState,
  ConflictChoice,
  CoverCandidate,
  CoverFetchReport,
  Game,
  RunningGame,
  SaveLocation,
  ScanReport,
  Settings,
  StorageReport,
  SyncDevice,
  SyncProgress,
  SyncResult,
  SyncServerInfo
} from '../shared/types'

type Result = { ok: boolean; error?: string }

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('state:get'),

  scan: (): Promise<ScanReport> => ipcRenderer.invoke('library:scan'),
  addRoot: (): Promise<{ added: number }> => ipcRenderer.invoke('roots:add'),
  removeRoot: (id: string, alsoRemoveGames: boolean): Promise<void> =>
    ipcRenderer.invoke('roots:remove', id, alsoRemoveGames),
  renameRoot: (id: string, label: string): Promise<void> =>
    ipcRenderer.invoke('roots:rename', id, label),
  addGameFolder: (): Promise<{ added: number }> => ipcRenderer.invoke('games:addFolder'),

  updateGame: (id: string, patch: Partial<Game>): Promise<Game | null> =>
    ipcRenderer.invoke('game:update', id, patch),
  removeGame: (id: string): Promise<void> => ipcRenderer.invoke('game:remove', id),
  launch: (id: string): Promise<Result> => ipcRenderer.invoke('game:launch', id),
  markStopped: (id: string): Promise<void> => ipcRenderer.invoke('game:markStopped', id),
  openFolder: (id: string): Promise<void> => ipcRenderer.invoke('game:openFolder', id),
  rescanGame: (id: string): Promise<Game | null> => ipcRenderer.invoke('game:rescan', id),
  pickExe: (id: string): Promise<string | null> => ipcRenderer.invoke('game:pickExe', id),
  pickCover: (id: string): Promise<string | null> => ipcRenderer.invoke('game:pickCover', id),

  searchCovers: (query: string): Promise<CoverCandidate[]> =>
    ipcRenderer.invoke('covers:search', query),
  applyCover: (id: string, candidate: CoverCandidate): Promise<string | null> =>
    ipcRenderer.invoke('covers:apply', id, candidate),
  fetchMissingCovers: (): Promise<CoverFetchReport> => ipcRenderer.invoke('covers:fetchMissing'),

  detectSaveLocations: (id: string): Promise<SaveLocation[]> =>
    ipcRenderer.invoke('saves:detect', id),
  addSavePath: (id: string): Promise<string | null> => ipcRenderer.invoke('saves:add', id),
  setSavePaths: (id: string, paths: string[]): Promise<string[] | null> =>
    ipcRenderer.invoke('saves:setPaths', id, paths),
  describePath: (token: string): Promise<string> => ipcRenderer.invoke('saves:describe', token),

  testSync: (): Promise<Result> => ipcRenderer.invoke('sync:test'),
  syncServerInfo: (url: string): Promise<SyncServerInfo> =>
    ipcRenderer.invoke('sync:serverInfo', url),
  syncSignIn: (
    username: string,
    password: string,
    inviteCode?: string
  ): Promise<Result & { username?: string }> =>
    ipcRenderer.invoke('sync:signIn', username, password, inviteCode),
  syncSignOut: (): Promise<void> => ipcRenderer.invoke('sync:signOut'),
  syncDevices: (): Promise<SyncDevice[]> => ipcRenderer.invoke('sync:devices'),
  syncRevokeDevice: (id: string): Promise<boolean> => ipcRenderer.invoke('sync:revokeDevice', id),
  syncChangePassword: (current: string, next: string): Promise<Result> =>
    ipcRenderer.invoke('sync:changePassword', current, next),
  syncNow: (): Promise<SyncResult> => ipcRenderer.invoke('sync:now'),
  resolveConflict: (gameId: string, choice: ConflictChoice): Promise<boolean> =>
    ipcRenderer.invoke('sync:resolve', gameId, choice),

  storageReport: (): Promise<StorageReport> => ipcRenderer.invoke('storage:report'),
  measureStorage: (all: boolean): Promise<{ measured: number; bytes: number }> =>
    ipcRenderer.invoke('storage:measure', all),
  measureGame: (id: string): Promise<number | null> => ipcRenderer.invoke('storage:measureGame', id),
  deleteGameFiles: (id: string): Promise<Result & { freed: number }> =>
    ipcRenderer.invoke('storage:deleteFiles', id),
  trimBackups: (days: number): Promise<{ removed: number; freed: number }> =>
    ipcRenderer.invoke('storage:trimBackups', days),
  pruneCovers: (): Promise<{ removed: number; freed: number }> =>
    ipcRenderer.invoke('storage:pruneCovers'),
  onStorageProgress: (
    cb: (progress: { done: number; total: number; title: string }) => void
  ): (() => void) => {
    const listener = (_e: unknown, progress: { done: number; total: number; title: string }): void =>
      cb(progress)
    ipcRenderer.on('storage:progress', listener)
    return () => ipcRenderer.removeListener('storage:progress', listener)
  },

  vaultSetPassword: (password: string): Promise<Result> =>
    ipcRenderer.invoke('vault:setPassword', password),
  vaultUnlock: (password: string): Promise<Result> => ipcRenderer.invoke('vault:unlock', password),
  vaultLock: (): Promise<void> => ipcRenderer.invoke('vault:lock'),
  vaultChange: (current: string, next: string): Promise<Result> =>
    ipcRenderer.invoke('vault:change', current, next),
  vaultDisable: (current: string): Promise<Result> => ipcRenderer.invoke('vault:disable', current),

  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:update', patch),
  dataPath: (): Promise<string> => ipcRenderer.invoke('app:dataPath'),
  showItem: (target: string): Promise<void> => ipcRenderer.invoke('app:showItem', target),

  /** Cover images are served through the app's own scheme, never file://. */
  imageUrl: (absolutePath: string): string =>
    `gameimg://img?p=${encodeURIComponent(absolutePath)}`,

  onStateChanged: (cb: (state: AppState) => void): (() => void) => {
    const listener = (_e: unknown, state: AppState): void => cb(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  },
  onRunningChanged: (cb: (running: RunningGame[]) => void): (() => void) => {
    const listener = (_e: unknown, running: RunningGame[]): void => cb(running)
    ipcRenderer.on('running:changed', listener)
    return () => ipcRenderer.removeListener('running:changed', listener)
  },
  onCoverProgress: (
    cb: (progress: { done: number; total: number; title: string }) => void
  ): (() => void) => {
    const listener = (_e: unknown, progress: { done: number; total: number; title: string }): void =>
      cb(progress)
    ipcRenderer.on('covers:progress', listener)
    return () => ipcRenderer.removeListener('covers:progress', listener)
  },
  onSyncProgress: (cb: (progress: SyncProgress) => void): (() => void) => {
    const listener = (_e: unknown, progress: SyncProgress): void => cb(progress)
    ipcRenderer.on('sync:progress', listener)
    return () => ipcRenderer.removeListener('sync:progress', listener)
  },
  onScanProgress: (cb: (name: string) => void): (() => void) => {
    const listener = (_e: unknown, name: string): void => cb(name)
    ipcRenderer.on('scan:progress', listener)
    return () => ipcRenderer.removeListener('scan:progress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
