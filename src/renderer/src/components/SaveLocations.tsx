import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Game, SaveLocation } from '../../../shared/types'

/** Turns "{APPDATA}/RenPy/Game" into "%APPDATA%/RenPy/Game" for display. */
const pretty = (token: string): string => token.replace(/^\{([A-Z]+)\}/, (_m, n: string) => `%${n}%`)

export default function SaveLocations({ game }: { game: Game }): JSX.Element {
  const [suggestions, setSuggestions] = useState<SaveLocation[] | null>(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => setSuggestions(null), [game.id])

  const detect = async (): Promise<void> => {
    setScanning(true)
    const found = await api.detectSaveLocations(game.id)
    setSuggestions(found.filter((f) => !game.savePaths.includes(f.path)))
    setScanning(false)
  }

  const remove = (token: string): void => {
    api.setSavePaths(game.id, game.savePaths.filter((p) => p !== token))
  }

  const accept = (token: string): void => {
    api.setSavePaths(game.id, [...game.savePaths, token])
    setSuggestions((prev) => (prev ?? []).filter((s) => s.path !== token))
  }

  return (
    <div className="field">
      <label>Save locations</label>

      {game.savePaths.length === 0 ? (
        <p className="dim" style={{ margin: 0, fontSize: 12 }}>
          None set, so this game's saves are not synced.
        </p>
      ) : (
        <ul className="save-list">
          {game.savePaths.map((token) => (
            <li key={token}>
              <span className="truncate" title={pretty(token)}>
                {pretty(token)}
              </span>
              <button className="btn small" onClick={() => remove(token)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="row">
        <button className="btn small" disabled={scanning} onClick={detect}>
          {scanning ? 'Looking…' : 'Find saves'}
        </button>
        <button className="btn small" onClick={() => api.addSavePath(game.id)}>
          Add folder…
        </button>
      </div>

      {suggestions !== null && suggestions.length === 0 && (
        <p className="dim" style={{ margin: 0, fontSize: 11 }}>
          Nothing found automatically — add the folder by hand if you know it.
        </p>
      )}
      {suggestions !== null && suggestions.length > 0 && (
        <ul className="save-list">
          {suggestions.map((s) => (
            <li key={s.path}>
              <span className="truncate" title={pretty(s.path)}>
                {pretty(s.path)} <span className="dim">· {s.source}</span>
              </span>
              <button className="btn small" onClick={() => accept(s.path)}>
                Use
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
