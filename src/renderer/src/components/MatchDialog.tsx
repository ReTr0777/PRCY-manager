import { useState } from 'react'
import { api } from '../api'
import type { TitleSuggestion } from '../../../shared/types'

interface Props {
  suggestions: TitleSuggestion[]
  onClose: () => void
  onToast: (message: string) => void
}

/**
 * Sync pairs games by title, so a game called something slightly different on
 * each device stays two entries and never shares a save. These are the near
 * misses, offered rather than applied: only the user knows whether two similar
 * names are one game or two.
 */
export default function MatchDialog({ suggestions, onClose, onToast }: Props): JSX.Element {
  const [done, setDone] = useState<Record<string, string>>({})
  const [renameFolders, setRenameFolders] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const remaining = suggestions.filter((s) => !done[s.gameId])

  const apply = async (suggestion: TitleSuggestion): Promise<void> => {
    const rename = renameFolders && suggestion.folderRenameTo !== null
    setBusy(suggestion.gameId)
    const result = await api.applyTitleMatch(suggestion.gameId, suggestion.remoteTitle, rename)
    setBusy(null)
    if (!result.ok) {
      onToast(result.error ?? 'Could not apply that.')
      return
    }
    setDone((d) => ({ ...d, [suggestion.gameId]: suggestion.remoteTitle }))
    onToast(
      rename
        ? `Renamed to “${suggestion.remoteTitle}” — folder and all. Sync again to pair them.`
        : `Renamed to “${suggestion.remoteTitle}”. Sync again to pair them.`
    )
  }

  return (
    <div className="modal-backdrop">
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Same game, different name?</h2>
        <p className="dim">
          These games look like ones another device already has, under a name that does not quite
          match. Games are paired by title, so until the names agree they stay separate and their
          saves never meet.
        </p>

        <label className="check">
          <input
            type="checkbox"
            checked={renameFolders}
            onChange={(e) => setRenameFolders(e.target.checked)}
          />
          Rename the folder on disk too, so a later scan produces the same name by itself
        </label>

        <ul className="match-list">
          {suggestions.map((s) => {
            const applied = done[s.gameId]
            return (
              <li key={s.gameId} className={applied ? 'applied' : ''}>
                <div className="match-names">
                  <div className="truncate" title={s.localFolder}>
                    <span className="dim">here</span> {s.localTitle}
                  </div>
                  <div className="truncate">
                    <span className="dim">
                      {s.remoteDevice ? `on ${s.remoteDevice}` : 'on the server'}
                    </span>{' '}
                    {s.remoteTitle}
                    {s.remoteHasSave && <span className="badge-save">has a save</span>}
                  </div>
                  {renameFolders && s.folderRenameTo && !applied && (
                    <div className="dim small-text truncate">
                      folder → {s.folderRenameTo}
                    </div>
                  )}
                  {renameFolders && !s.folderRenameTo && !applied && (
                    <div className="dim small-text">that name cannot be a folder name — title only</div>
                  )}
                </div>
                <span className="dim small-text">{Math.round(s.similarity * 100)}% alike</span>
                {applied ? (
                  <span className="ok-text">renamed</span>
                ) : (
                  <>
                    <button
                      className="btn small primary"
                      disabled={busy !== null}
                      onClick={() => apply(s)}
                    >
                      {busy === s.gameId ? 'Working…' : 'Same game'}
                    </button>
                    <button
                      className="btn small"
                      onClick={() => {
                        void api.dismissTitleMatch(s.gameId, s.remoteTitle)
                        setDone((d) => ({ ...d, [s.gameId]: '' }))
                      }}
                    >
                      Different
                    </button>
                  </>
                )}
              </li>
            )
          })}
        </ul>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {remaining.length > 0 ? 'Not now' : 'Close'}
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              onClose()
              await api.syncNow()
            }}
          >
            Done — sync again
          </button>
        </div>
      </div>
    </div>
  )
}
