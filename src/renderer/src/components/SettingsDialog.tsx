import { useEffect, useState } from 'react'
import { api } from '../api'
import SyncSettings from './SyncSettings'
import type { AppState, SaveConflict, TitleSuggestion } from '../../../shared/types'

interface Props {
  state: AppState
  onClose: () => void
  onToast: (message: string) => void
  onConflicts: (conflicts: SaveConflict[]) => void
  onMatches: (suggestions: TitleSuggestion[]) => void
}

export default function SettingsDialog({ state, onClose, onToast, onConflicts, onMatches }: Props): JSX.Element {
  const [dataPath, setDataPath] = useState('')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [fetching, setFetching] = useState<string | null>(null)
  const missingCovers = state.games.filter((g) => !g.coverPath && !g.missing).length

  useEffect(() => {
    api.dataPath().then(setDataPath)
    return api.onCoverProgress(({ done, total, title }) =>
      setFetching(`${done}/${total} — ${title}`)
    )
  }, [])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <section>
          <h3>Library folders</h3>
          {state.roots.length === 0 && <p className="dim">Nothing added yet.</p>}
          <ul className="root-list">
            {state.roots.map((root) => (
              <li key={root.id}>
                <input
                  defaultValue={root.label}
                  onBlur={(e) => api.renameRoot(root.id, e.target.value)}
                />
                <span className="path truncate" title={root.path}>
                  {root.path || 'Games added one at a time'}
                </span>
                <button
                  className="btn small danger"
                  onClick={() => {
                    const drop = confirm(
                      `Remove “${root.label}”?\n\nOK also forgets its games (playtime included).\nCancel keeps the games but stops scanning this folder.`
                    )
                    api.removeRoot(root.id, drop)
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <button className="btn" onClick={() => api.addRoot()}>
            Add folder…
          </button>
        </section>

        <section>
          <h3>Launching</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={state.settings.minimizeOnLaunch}
              onChange={(e) => api.updateSettings({ minimizeOnLaunch: e.target.checked })}
            />
            Minimise the window when a game starts
          </label>
          <label className="check">
            Ignore sessions shorter than
            <input
              type="number"
              min={0}
              max={600}
              value={state.settings.minSessionSeconds}
              onChange={(e) => api.updateSettings({ minSessionSeconds: Number(e.target.value) })}
            />
            seconds
          </label>
          <p className="dim">
            Playtime is measured from the process you launch. Games that hand off to another
            executable are followed by name; use “Mark as closed” if a timer ever gets stuck.
          </p>
        </section>

        <section>
          <h3>Cover art</h3>
          <p className="dim">
            Covers come from Steam's store, which needs no account. A free SteamGridDB key adds a
            second source with community-made art, including for games that were never on Steam.
          </p>
          <input
            type="password"
            placeholder="SteamGridDB API key (optional)"
            defaultValue={state.settings.steamGridDbKey ?? ''}
            onBlur={(e) => api.updateSettings({ steamGridDbKey: e.target.value.trim() || null })}
            style={{ width: '100%' }}
          />
          <div className="row">
            <button
              className="btn"
              disabled={fetching !== null}
              onClick={async () => {
                setFetching('Starting…')
                const report = await api.fetchMissingCovers()
                setFetching(null)
                onToast(
                  `Covers: ${report.updated} added, ${report.skipped} without a confident match, ${report.failed} failed.`
                )
              }}
            >
              {fetching ? 'Fetching…' : 'Fetch missing covers'}
            </button>
            {missingCovers > 0 && <span className="dim">{missingCovers} games have no art</span>}
          </div>
          {fetching && <div className="scan-progress truncate">{fetching}</div>}
          <p className="dim">
            Bulk fetching only applies art when the result's title is a close match, so it will skip
            rather than guess. Anything skipped can be picked by hand from the game's detail panel.
          </p>
        </section>

        <SyncSettings state={state} onToast={onToast} onConflicts={onConflicts} onMatches={onMatches} />

        <section>
          <h3>Hidden vault</h3>
          {state.vault === 'unset' ? (
            <p className="dim">No vault yet — hide a game from its detail panel to create one.</p>
          ) : (
            <>
              <div className="row">
                <input
                  type="password"
                  placeholder="Current password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
                <input
                  type="password"
                  placeholder="New password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                />
                <button
                  className="btn"
                  onClick={async () => {
                    const result = await api.vaultChange(current, next)
                    onToast(result.ok ? 'Password changed.' : result.error ?? 'Failed.')
                    if (result.ok) {
                      setCurrent('')
                      setNext('')
                    }
                  }}
                >
                  Change
                </button>
              </div>
              <button
                className="btn danger"
                onClick={async () => {
                  if (!confirm('Turn off the vault and un-hide every hidden game?')) return
                  const result = await api.vaultDisable(current)
                  onToast(result.ok ? 'Vault removed.' : result.error ?? 'Wrong password.')
                }}
              >
                Disable vault (needs current password)
              </button>
            </>
          )}
        </section>

        <section>
          <h3>Data</h3>
          <p className="path truncate" title={dataPath}>
            {dataPath}
          </p>
          <button className="btn small" onClick={() => api.showItem(dataPath)}>
            Show library file
          </button>
        </section>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
