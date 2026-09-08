import { useEffect, useState } from 'react'
import { api, formatDate, formatPlaytime, formatSize } from '../api'
import CoverSearchDialog from './CoverSearchDialog'
import SaveLocations from './SaveLocations'
import type { Game, VaultState } from '../../../shared/types'

interface Props {
  game: Game
  running: boolean
  vaultState: VaultState
  hasSteamGridKey: boolean
  onClose: () => void
  onLaunch: () => void
  onNeedVault: () => void
  onToast: (message: string) => void
}

export default function GameDetail(props: Props): JSX.Element {
  const { game, running, vaultState } = props
  const [title, setTitle] = useState(game.title)
  const [tags, setTags] = useState(game.tags.join(', '))
  const [notes, setNotes] = useState(game.notes)
  const [showExes, setShowExes] = useState(false)
  const [showCovers, setShowCovers] = useState(false)

  useEffect(() => {
    setTitle(game.title)
    setTags(game.tags.join(', '))
    setNotes(game.notes)
    setShowExes(false)
    setShowCovers(false)
  }, [game.id])

  const save = (patch: Partial<Game>): void => {
    api.updateGame(game.id, patch)
  }

  const toggleHidden = (): void => {
    if (vaultState === 'unset') {
      props.onNeedVault()
      return
    }
    save({ hidden: !game.hidden })
    if (!game.hidden) props.onToast(`“${game.title}” moved to the hidden vault.`)
  }

  return (
    <aside className="detail">
      <button className="close" onClick={props.onClose} title="Close">
        ✕
      </button>

      <input
        className="detail-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== game.title && save({ title: title.trim() })}
      />

      <div className="detail-actions">
        <button className="btn primary" disabled={!game.exePath || game.missing || running} onClick={props.onLaunch}>
          {running ? 'Running…' : '▶ Play'}
        </button>
        {running && (
          <button className="btn" onClick={() => api.markStopped(game.id)} title="Stop timing this session">
            Mark as closed
          </button>
        )}
        <button className={`btn${game.favorite ? ' active' : ''}`} onClick={() => save({ favorite: !game.favorite })}>
          {game.favorite ? '★ Favorite' : '☆ Favorite'}
        </button>
      </div>

      {game.missing && <div className="warning">This folder is no longer on disk.</div>}

      <dl className="facts">
        <dt>Playtime</dt>
        <dd>{formatPlaytime(game.playtimeSeconds)}</dd>
        <dt>Last played</dt>
        <dd>{formatDate(game.lastPlayed)}</dd>
        <dt>Added</dt>
        <dd>{formatDate(game.addedAt)}</dd>
        <dt>On disk</dt>
        <dd>
          {typeof game.sizeBytes === 'number' ? (
            formatSize(game.sizeBytes)
          ) : (
            <button className="btn small" onClick={() => api.measureGame(game.id)}>
              Measure
            </button>
          )}
        </dd>
      </dl>

      <div className="field">
        <label>Executable</label>
        <div className="path" title={game.exePath ?? ''}>
          {game.exePath ?? 'None found — pick one below.'}
        </div>
        <div className="row">
          <button className="btn small" onClick={() => api.pickExe(game.id)}>
            Browse…
          </button>
          {game.exeCandidates.length > 1 && (
            <button className="btn small" onClick={() => setShowExes((v) => !v)}>
              {showExes ? 'Hide' : `${game.exeCandidates.length} found`}
            </button>
          )}
          <button className="btn small" onClick={() => api.rescanGame(game.id)}>
            Rescan folder
          </button>
        </div>
        {showExes && (
          <ul className="exe-list">
            {game.exeCandidates.map((c) => (
              <li key={c.path}>
                <button
                  className={c.path === game.exePath ? 'active' : ''}
                  onClick={() => {
                    save({ exePath: c.path })
                    setShowExes(false)
                  }}
                  title={c.path}
                >
                  <span className="truncate">{c.path.split('\\').pop()}</span>
                  <span className="dim">{formatSize(c.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="field">
        <label>Tags</label>
        <input
          value={tags}
          placeholder="roguelike, cozy, demo"
          onChange={(e) => setTags(e.target.value)}
          onBlur={() =>
            save({ tags: tags.split(',').map((t) => t.trim()).filter(Boolean) })
          }
        />
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea
          rows={4}
          value={notes}
          placeholder="Where you got it, controls, save location…"
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => save({ notes })}
        />
      </div>

      <div className="field">
        <label>Cover</label>
        <div className="row">
          <button className="btn small primary" onClick={() => setShowCovers(true)}>
            Find online…
          </button>
          <button className="btn small" onClick={() => api.pickCover(game.id)}>
            From file…
          </button>
          {game.coverPath && (
            <button className="btn small" onClick={() => save({ coverPath: null })}>
              Clear
            </button>
          )}
        </div>
      </div>

      <SaveLocations game={game} />

      <div className="field">
        <label>Folder</label>
        <div className="path" title={game.folder}>
          {game.folder}
        </div>
        <button className="btn small" onClick={() => api.openFolder(game.id)}>
          Open in Explorer
        </button>
      </div>

      <div className="detail-footer">
        <button className={`btn${game.hidden ? ' active' : ''}`} onClick={toggleHidden}>
          {game.hidden ? '🔓 Unhide' : '🔒 Hide in vault'}
        </button>
        <button
          className="btn danger"
          onClick={() => {
            if (confirm(`Remove “${game.title}” from the library? Files on disk are not touched.`)) {
              api.removeGame(game.id)
              props.onClose()
            }
          }}
        >
          Remove from library
        </button>
      </div>

      {showCovers && (
        <CoverSearchDialog
          game={game}
          hasSteamGridKey={props.hasSteamGridKey}
          onClose={() => setShowCovers(false)}
          onToast={props.onToast}
        />
      )}
    </aside>
  )
}
