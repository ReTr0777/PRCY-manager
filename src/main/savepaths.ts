import { app } from 'electron'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Game, SaveLocation } from '../shared/types'

/**
 * Save folders live under per-user paths that differ on every machine, so a
 * location is stored tokenised ("{APPDATA}/RenPy/Game") and expanded when used.
 * That is what lets an archive captured on one PC land in the right place on
 * another with a different username.
 */

function tokenMap(gameFolder?: string): [string, string][] {
  const home = os.homedir()
  // Longest paths first: %LOCALAPPDATA% must win over %USERPROFILE%.
  const pairs: [string, string][] = [
    ['{LOCALAPPDATALOW}', path.join(home, 'AppData', 'LocalLow')],
    ['{LOCALAPPDATA}', app.getPath('appData').replace(/Roaming$/i, 'Local')],
    ['{APPDATA}', app.getPath('appData')],
    ['{SAVEDGAMES}', path.join(home, 'Saved Games')],
    ['{DOCUMENTS}', app.getPath('documents')],
    ['{USERPROFILE}', home]
  ]
  if (gameFolder) pairs.unshift(['{GAMEDIR}', gameFolder])
  return pairs.sort((a, b) => b[1].length - a[1].length)
}

export function tokenise(absolute: string, gameFolder?: string): string {
  const normalised = path.resolve(absolute)
  for (const [token, base] of tokenMap(gameFolder)) {
    if (normalised.toLowerCase().startsWith(base.toLowerCase())) {
      return token + normalised.slice(base.length).split(path.sep).join('/')
    }
  }
  return normalised.split(path.sep).join('/')
}

export function expand(tokenised: string, gameFolder?: string): string {
  for (const [token, base] of tokenMap(gameFolder)) {
    if (tokenised.startsWith(token)) {
      return path.join(base, ...tokenised.slice(token.length).split('/').filter(Boolean))
    }
  }
  return path.normalize(tokenised)
}

/** Human-readable form for the UI, without leaking the whole home path. */
export function describe(tokenised: string): string {
  return tokenised.replace(/^\{([A-Z]+)\}/, (_m, name: string) => `%${name}%`)
}

// --- detection ---------------------------------------------------------------

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Names inside a game folder that hold saves rather than game data. */
const IN_GAME_SAVE_DIRS = ['save', 'saves', 'savedata', 'savegame', 'savegames', 'userdata', 'profiles']

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** Does this folder name plausibly belong to this game? */
function matches(candidate: string, needles: string[]): boolean {
  const c = norm(candidate)
  if (c.length < 3) return false
  return needles.some((n) => n.length >= 3 && (c === n || c.includes(n) || n.includes(c)))
}

/**
 * Looks for a game's saves in the places Windows games actually use. Returns
 * tokenised locations with a note on where each came from, for the user to
 * confirm — nothing is synced until a location is on the game's list.
 */
export async function detectSaveLocations(game: Game): Promise<SaveLocation[]> {
  const home = os.homedir()
  const appData = app.getPath('appData')
  const localAppData = appData.replace(/Roaming$/i, 'Local')
  const localLow = path.join(home, 'AppData', 'LocalLow')
  const documents = app.getPath('documents')

  const exeName = game.exePath ? path.basename(game.exePath, path.extname(game.exePath)) : ''
  const needles = [game.title, path.basename(game.folder), exeName].map(norm).filter((n) => n.length >= 3)

  const found: SaveLocation[] = []
  const add = (absolute: string, source: string): void => {
    const token = tokenise(absolute, game.folder)
    if (!found.some((f) => f.path.toLowerCase() === token.toLowerCase())) {
      found.push({ path: token, source })
    }
  }

  // Engines with a fixed layout, checked by name.
  for (const base of [appData, localAppData, localLow, path.join(documents, 'My Games'), path.join(home, 'Saved Games')]) {
    for (const name of await subdirs(base)) {
      if (matches(name, needles)) add(path.join(base, name), path.basename(base))
    }
  }

  // Ren'Py and Godot nest under a vendor folder; RPG Maker keeps saves in place.
  for (const [vendorBase, label] of [
    [path.join(appData, 'RenPy'), "Ren'Py"],
    [path.join(appData, 'Godot', 'app_userdata'), 'Godot'],
    [path.join(localLow), 'Unity']
  ] as const) {
    for (const name of await subdirs(vendorBase)) {
      if (matches(name, needles)) add(path.join(vendorBase, name), label)
      else {
        // Unity nests as LocalLow/<Company>/<Product>, so check one level down.
        if (label !== 'Unity') continue
        for (const product of await subdirs(path.join(vendorBase, name))) {
          if (matches(product, needles)) add(path.join(vendorBase, name, product), 'Unity')
        }
      }
    }
  }

  // Saves kept inside the game folder, which is common for itch and RPG Maker.
  for (const name of await subdirs(game.folder)) {
    if (IN_GAME_SAVE_DIRS.includes(name.toLowerCase())) add(path.join(game.folder, name), 'game folder')
  }
  for (const nested of ['www/save', 'game/saves']) {
    const target = path.join(game.folder, ...nested.split('/'))
    if (await exists(target)) add(target, 'game folder')
  }

  return found
}
