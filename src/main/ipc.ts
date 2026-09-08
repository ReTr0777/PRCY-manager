import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { checkForUpdate, downloadUpdate, installUpdate } from './appupdate'
import { applyCover, fetchMissingCovers, searchCovers } from './covers'
import { describe, detectSaveLocations, tokenise } from './savepaths'
import {
  applyTitleMatch,
  changeServerPassword,
  listSaveVersions,
  restoreSaveVersion,
  syncBeforeLaunch,
  dismissTitleMatch,
  listDevices,
  resolveConflict,
  revokeDevice,
  normaliseServerUrl,
  serverInfo,
  signIn,
  signOut,
  syncNow,
  testConnection
} from './sync'
import { gameId, inspectFolder, prettifyTitle, scanAll } from './scanner'
import {
  deleteGameFiles,
  measureGames,
  pruneCovers,
  storageReport,
  trimSaveBackups
} from './storage'
import * as launcher from './launcher'
import { store } from './store'
import { vault } from './vault'
import type { AppState, ConflictChoice, CoverCandidate, Game, Settings } from '../shared/types'

/** Fields the renderer is allowed to change directly. */
const EDITABLE: (keyof Game)[] = ['title', 'tags', 'notes', 'favorite', 'hidden', 'exePath', 'coverPath']

function visibleGames(): Game[] {
  return vault.isUnlocked ? store.games : store.games.filter((g) => !g.hidden)
}

function appState(): AppState {
  return {
    games: visibleGames(),
    roots: store.roots,
    settings: store.settings,
    vault: vault.state,
    running: launcher.list()
  }
}

/** Refuses to touch a hidden game while the vault is locked. */
function reachable(id: string): Game | null {
  const game = store.findGame(id)
  if (!game) return null
  if (game.hidden && !vault.isUnlocked) return null
  return game
}

function broadcast(): void {
  const state = appState()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('state:changed', state)
}

export function registerIpc(): void {
  ipcMain.handle('state:get', () => appState())

  // --- library -------------------------------------------------------------

  ipcMain.handle('library:scan', async (event) => {
    const report = await scanAll((name) => event.sender.send('scan:progress', name))
    broadcast()
    return report
  })

  ipcMain.handle('roots:add', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Pick a folder that contains your game folders',
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled) return { added: 0 }
    let added = 0
    for (const folder of result.filePaths) if (store.addRoot(folder)) added++
    broadcast()
    return { added }
  })

  ipcMain.handle('roots:remove', (_e, id: string, alsoRemoveGames: boolean) => {
    store.removeRoot(id, alsoRemoveGames)
    broadcast()
  })

  ipcMain.handle('roots:rename', (_e, id: string, label: string) => {
    const root = store.roots.find((r) => r.id === id)
    if (root) {
      root.label = label.trim() || root.label
      store.save()
      broadcast()
    }
  })

  /** Add a single game folder that does not live under any root. */
  ipcMain.handle('games:addFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Pick a game folder',
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled) return { added: 0 }

    // Loose games get a placeholder root so they survive a rescan.
    let looseRoot = store.roots.find((r) => r.path === '')
    if (!looseRoot) looseRoot = store.addRoot('', 'Added by hand')!
    let added = 0
    for (const folder of result.filePaths) {
      if (store.findGameByFolder(folder)) continue
      const info = await inspectFolder(folder)
      store.addGame({
        id: gameId(folder),
        title: prettifyTitle(path.basename(folder)),
        folder,
        rootId: looseRoot.id,
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
      })
      added++
    }
    store.save()
    broadcast()
    return { added }
  })

  // --- one game ------------------------------------------------------------

  ipcMain.handle('game:update', (_e, id: string, patch: Partial<Game>) => {
    if (!reachable(id)) return null
    const clean: Partial<Game> = {}
    for (const key of EDITABLE) if (key in patch) (clean as Record<string, unknown>)[key] = patch[key]
    // Hiding a game is only meaningful once a vault password exists.
    if (clean.hidden && vault.state === 'unset') delete clean.hidden
    const updated = store.updateGame(id, clean)
    broadcast()
    return updated ?? null
  })

  ipcMain.handle('game:remove', (_e, id: string) => {
    if (!reachable(id)) return
    store.removeGame(id)
    broadcast()
  })

  ipcMain.handle('game:launch', async (_e, id: string) => {
    if (!reachable(id)) return { ok: false, error: 'Game is locked.' }

    // Fetch the newest save before starting, so a session begun on one device
    // continues from where the other left off rather than colliding with it.
    const prep = await syncBeforeLaunch(id)
    if (prep.conflict) {
      broadcast()
      return { ok: false, conflict: prep.conflict }
    }

    const result = await launcher.launch(id)
    broadcast()
    return { ...result, pulledFrom: prep.pulledFrom }
  })

  ipcMain.handle('game:markStopped', (_e, id: string) => {
    launcher.markStopped(id)
    broadcast()
  })

  ipcMain.handle('game:openFolder', (_e, id: string) => {
    const game = reachable(id)
    if (game) shell.openPath(game.folder)
  })

  ipcMain.handle('game:rescan', async (_e, id: string) => {
    const game = reachable(id)
    if (!game) return null
    const info = await inspectFolder(game.folder)
    game.exeCandidates = info.exeCandidates
    game.missing = !fs.existsSync(game.folder)
    if (!game.exePath) game.exePath = info.exePath
    if (!game.coverPath) game.coverPath = info.coverPath
    store.save()
    broadcast()
    return game
  })

  ipcMain.handle('game:pickExe', async (_e, id: string) => {
    const game = reachable(id)
    if (!game) return null
    const result = await dialog.showOpenDialog({
      title: 'Pick the executable to launch',
      defaultPath: game.folder,
      properties: ['openFile'],
      filters: [{ name: 'Runnable', extensions: ['exe', 'bat', 'cmd', 'lnk', 'jar', 'html', 'swf'] }]
    })
    if (result.canceled) return null
    store.updateGame(id, { exePath: result.filePaths[0] })
    broadcast()
    return result.filePaths[0]
  })

  ipcMain.handle('game:pickCover', async (_e, id: string) => {
    const game = reachable(id)
    if (!game) return null
    const result = await dialog.showOpenDialog({
      title: 'Pick a cover image',
      defaultPath: game.folder,
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    if (result.canceled) return null
    store.updateGame(id, { coverPath: result.filePaths[0], coverChosen: true })
    broadcast()
    return result.filePaths[0]
  })

  // --- cover art -----------------------------------------------------------

  ipcMain.handle('covers:search', (_e, query: string) => searchCovers(query))

  ipcMain.handle('covers:apply', async (_e, id: string, candidate: CoverCandidate) => {
    if (!reachable(id)) return null
    const file = await applyCover(id, candidate)
    broadcast()
    return file
  })

  ipcMain.handle('covers:fetchMissing', async (event) => {
    const report = await fetchMissingCovers((done, total, title) =>
      event.sender.send('covers:progress', { done, total, title })
    )
    broadcast()
    return report
  })

  // --- save locations ------------------------------------------------------

  ipcMain.handle('saves:detect', async (_e, id: string) => {
    const game = reachable(id)
    return game ? await detectSaveLocations(game) : []
  })

  ipcMain.handle('saves:add', async (_e, id: string) => {
    const game = reachable(id)
    if (!game) return null
    const result = await dialog.showOpenDialog({
      title: 'Pick the folder this game saves into',
      defaultPath: game.folder,
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    const token = tokenise(result.filePaths[0], game.folder)
    if (!game.savePaths.includes(token)) {
      store.updateGame(id, { savePaths: [...game.savePaths, token] })
    }
    broadcast()
    return token
  })

  ipcMain.handle('saves:setPaths', (_e, id: string, paths: string[]) => {
    if (!reachable(id)) return null
    store.updateGame(id, { savePaths: paths })
    broadcast()
    return paths
  })

  ipcMain.handle('saves:describe', (_e, token: string) => describe(token))

  ipcMain.handle('saves:versions', (_e, id: string) =>
    reachable(id) ? listSaveVersions(id) : []
  )

  ipcMain.handle('saves:restore', async (_e, id: string, versionId: string) => {
    if (!reachable(id)) return { ok: false, error: 'Game is locked.' }
    if (launcher.isRunning(id)) {
      return { ok: false, error: 'Close the game first — restoring over a running save loses it.' }
    }
    const result = await restoreSaveVersion(id, versionId)
    broadcast()
    return result
  })

  // --- sync ----------------------------------------------------------------

  ipcMain.handle('sync:test', () => testConnection())

  ipcMain.handle('sync:serverInfo', (_e, url: string) => serverInfo(url))

  ipcMain.handle(
    'sync:signIn',
    async (_e, username: string, password: string, inviteCode?: string) => {
      const result = await signIn(username, password, inviteCode)
      broadcast()
      return result
    }
  )

  ipcMain.handle('sync:signOut', async () => {
    await signOut()
    broadcast()
  })

  ipcMain.handle('sync:devices', () => listDevices())
  ipcMain.handle('sync:revokeDevice', (_e, id: string) => revokeDevice(id))
  ipcMain.handle('sync:changePassword', (_e, current: string, next: string) =>
    changeServerPassword(current, next)
  )

  ipcMain.handle('sync:now', async (event) => {
    const result = await syncNow((phase, message) =>
      event.sender.send('sync:progress', { phase, message })
    )
    broadcast()
    return result
  })

  ipcMain.handle(
    'sync:applyMatch',
    async (_e, gameId: string, remoteTitle: string, renameFolder: boolean) => {
      // Renaming a folder out from under a running game would break it.
      if (renameFolder && launcher.isRunning(gameId)) {
        return { ok: false, error: 'Close the game first — its folder cannot be renamed while it runs.' }
      }
      if (!reachable(gameId)) return { ok: false, error: 'Game is locked.' }
      const result = await applyTitleMatch(gameId, remoteTitle, renameFolder)
      broadcast()
      return result
    }
  )

  ipcMain.handle('sync:dismissMatch', (_e, gameId: string, remoteTitle: string) =>
    dismissTitleMatch(gameId, remoteTitle)
  )

  ipcMain.handle('sync:resolve', async (_e, gameId: string, choice: ConflictChoice) => {
    const done = await resolveConflict(gameId, choice)
    broadcast()
    return done
  })

  // --- updating the app -----------------------------------------------------

  ipcMain.handle('app:checkUpdate', () => checkForUpdate())

  ipcMain.handle('app:downloadUpdate', async (event, version: string) => {
    return downloadUpdate(version, (received, total) =>
      event.sender.send('app:updateProgress', { received, total })
    )
  })

  ipcMain.handle('app:installUpdate', (_e, file: string) => installUpdate(file))

  // --- storage --------------------------------------------------------------

  ipcMain.handle('storage:report', () => storageReport())

  ipcMain.handle('storage:measure', async (event, all: boolean) => {
    const result = await measureGames({ all }, (done, total, title) =>
      event.sender.send('storage:progress', { done, total, title })
    )
    broadcast()
    return result
  })

  ipcMain.handle('storage:measureGame', async (_e, id: string) => {
    if (!reachable(id)) return null
    await measureGames({ ids: [id] })
    broadcast()
    return store.findGame(id)?.sizeBytes ?? null
  })

  ipcMain.handle('storage:deleteFiles', async (_e, id: string) => {
    // Hidden games stay untouchable while the vault is locked, deletion most
    // of all.
    if (!reachable(id)) return { ok: false, error: 'Game is locked.', freed: 0 }
    const result = await deleteGameFiles(id)
    broadcast()
    return result
  })

  ipcMain.handle('storage:trimBackups', (_e, days: number) => trimSaveBackups(days))
  ipcMain.handle('storage:pruneCovers', () => pruneCovers())

  // --- vault ---------------------------------------------------------------

  ipcMain.handle('vault:setPassword', (_e, password: string) => {
    if (vault.state !== 'unset') return { ok: false, error: 'A password is already set.' }
    if (!password || password.length < 4) return { ok: false, error: 'Use at least 4 characters.' }
    vault.setPassword(password)
    broadcast()
    return { ok: true }
  })

  ipcMain.handle('vault:unlock', (_e, password: string) => {
    const ok = vault.unlock(password)
    if (ok) broadcast()
    return { ok, error: ok ? undefined : 'Wrong password.' }
  })

  ipcMain.handle('vault:lock', () => {
    vault.lock()
    broadcast()
  })

  ipcMain.handle('vault:change', (_e, current: string, next: string) => {
    if (!next || next.length < 4) return { ok: false, error: 'Use at least 4 characters.' }
    const ok = vault.changePassword(current, next)
    return { ok, error: ok ? undefined : 'Wrong current password.' }
  })

  ipcMain.handle('vault:disable', (_e, current: string) => {
    const ok = vault.disable(current)
    if (ok) broadcast()
    return { ok, error: ok ? undefined : 'Wrong password.' }
  })

  // --- settings ------------------------------------------------------------

  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => {
    // The vault fields are owned by the vault module, never by the UI.
    const { vaultHash: _hash, vaultSalt: _salt, ...safe } = patch
    // "tower.local:8787" is a perfectly reasonable thing to type.
    if (typeof safe.syncUrl === 'string') safe.syncUrl = normaliseServerUrl(safe.syncUrl)
    const settings = store.updateSettings(safe)
    broadcast()
    return settings
  })

  ipcMain.handle('app:dataPath', () => store.filePath)
  ipcMain.handle('app:showItem', (_e, target: string) => shell.showItemInFolder(target))
}
