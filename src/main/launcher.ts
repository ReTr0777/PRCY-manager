import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { store } from './store'
import { syncGameSaves } from './sync'
import type { RunningGame } from '../shared/types'

interface Session extends RunningGame {
  imageName: string
  poll: NodeJS.Timeout | null
}

const sessions = new Map<string, Session>()

/** Broadcast so every window's library reflects running/stopped state. */
function notify(): void {
  const payload = list()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('running:changed', payload)
}

export function list(): RunningGame[] {
  return [...sessions.values()].map(({ gameId, startedAt, pid }) => ({ gameId, startedAt, pid }))
}

export function isRunning(gameId: string): boolean {
  return sessions.has(gameId)
}

/**
 * Many games are a small launcher that starts the real executable and exits, so
 * the spawned child ending does not mean the game closed. After the child exits
 * we keep watching the process list for the same image name.
 */
function imageStillRunning(imageName: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false)
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${imageName}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true },
      (err, stdout) => resolve(!err && stdout.toLowerCase().includes(imageName.toLowerCase()))
    )
  })
}

function endSession(gameId: string): void {
  const session = sessions.get(gameId)
  if (!session) return
  if (session.poll) clearInterval(session.poll)
  sessions.delete(gameId)

  const seconds = Math.round((Date.now() - session.startedAt) / 1000)
  const game = store.findGame(gameId)
  if (game && seconds >= store.settings.minSessionSeconds) {
    game.playtimeSeconds += seconds
    game.lastPlayed = Date.now()
    store.save()
  }
  notify()

  // Push the save that was just written, so the next device gets it.
  void syncGameSaves(gameId).catch((err) => console.error('[sync after play]', err))
}

function watchAfterExit(gameId: string): void {
  const session = sessions.get(gameId)
  if (!session) return
  session.poll = setInterval(async () => {
    if (!(await imageStillRunning(session.imageName))) endSession(gameId)
  }, 5000)
}

export async function launch(gameId: string): Promise<{ ok: boolean; error?: string }> {
  const game = store.findGame(gameId)
  if (!game) return { ok: false, error: 'Game not found.' }
  if (!game.exePath) return { ok: false, error: 'No executable is set for this game.' }
  if (!fs.existsSync(game.exePath)) return { ok: false, error: `Missing file: ${game.exePath}` }
  if (sessions.has(gameId)) return { ok: false, error: 'That game is already running.' }

  const ext = path.extname(game.exePath).toLowerCase()
  const cwd = path.dirname(game.exePath)

  // Shortcuts and web builds have to go through the shell, which gives us no
  // process to watch, so those sessions are not timed.
  if (ext === '.lnk' || ext === '.html' || ext === '.swf') {
    const err = await shell.openPath(game.exePath)
    if (err) return { ok: false, error: err }
    game.lastPlayed = Date.now()
    store.save()
    return { ok: true }
  }

  try {
    const useShell = ext === '.bat' || ext === '.cmd'
    const child = spawn(game.exePath, [], {
      cwd,
      detached: true,
      stdio: 'ignore',
      shell: useShell,
      windowsHide: false
    })

    child.on('error', (err) => {
      sessions.delete(gameId)
      notify()
      console.error('[launcher]', err)
    })

    child.unref()
    if (!child.pid) return { ok: false, error: 'Could not start the process.' }

    sessions.set(gameId, {
      gameId,
      startedAt: Date.now(),
      pid: child.pid,
      imageName: path.basename(game.exePath),
      poll: null
    })
    child.on('exit', () => watchAfterExit(gameId))

    if (store.settings.minimizeOnLaunch) BrowserWindow.getAllWindows()[0]?.minimize()
    notify()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Manual override for when the watcher lost track of a game. */
export function markStopped(gameId: string): void {
  endSession(gameId)
}

export function shutdown(): void {
  for (const gameId of [...sessions.keys()]) endSession(gameId)
}
