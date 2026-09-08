import { totalPlaytime } from '../api'
import Logo from './Logo'
import type { AppState } from '../../../shared/types'
import type { View } from '../App'

interface Props {
  state: AppState
  view: View
  scanning: string | null
  onView: (view: View) => void
  onOpenHidden: () => void
  onScan: () => void
  onAddRoot: () => void
  onAddGame: () => void
  onSettings: () => void
  onStorage: () => void
  onLock: () => void
}

export default function Sidebar(props: Props): JSX.Element {
  const { state, view, scanning } = props
  const visible = state.games.filter((g) => !g.hidden)
  const counts = {
    all: visible.length,
    favorites: visible.filter((g) => g.favorite).length,
    recent: visible.filter((g) => g.lastPlayed !== null).length,
    unplayed: visible.filter((g) => totalPlaytime(g) === 0).length,
    missing: visible.filter((g) => g.missing).length,
    hidden: state.games.filter((g) => g.hidden).length
  }

  const item = (kind: Exclude<View, { kind: 'root' }>['kind'], label: string, count: number): JSX.Element => (
    <button
      className={`nav-item${view.kind === kind ? ' active' : ''}`}
      onClick={() => props.onView({ kind })}
    >
      <span>{label}</span>
      <span className="badge">{count}</span>
    </button>
  )

  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo size={32} />
        <div>
          <strong>PRCY Manager</strong>
          <small>{state.games.length} titles</small>
        </div>
      </div>

      <nav>
        {item('all', 'All games', counts.all)}
        {item('favorites', 'Favorites', counts.favorites)}
        {item('recent', 'Recently played', counts.recent)}
        {item('unplayed', 'Never played', counts.unplayed)}
        {counts.missing > 0 && item('missing', 'Missing folders', counts.missing)}

        <button
          className={`nav-item vault${view.kind === 'hidden' ? ' active' : ''}`}
          onClick={props.onOpenHidden}
        >
          <span>{state.vault === 'unlocked' ? '🔓 Hidden' : '🔒 Hidden'}</span>
          {state.vault === 'unlocked' && <span className="badge">{counts.hidden}</span>}
        </button>
        {state.vault === 'unlocked' && (
          <button className="nav-sub" onClick={props.onLock}>
            Lock vault
          </button>
        )}
      </nav>

      <div className="section-label">Libraries</div>
      <nav className="roots">
        {state.roots.length === 0 && <p className="hint">No folders added yet.</p>}
        {state.roots.map((root) => (
          <button
            key={root.id}
            className={`nav-item${view.kind === 'root' && view.id === root.id ? ' active' : ''}`}
            title={root.path || 'Games added one at a time'}
            onClick={() => props.onView({ kind: 'root', id: root.id })}
          >
            <span className="truncate">{root.label}</span>
            <span className="badge">{state.games.filter((g) => g.rootId === root.id && !g.hidden).length}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-actions">
        <button className="btn primary" onClick={props.onScan} disabled={scanning !== null}>
          {scanning ? 'Scanning…' : 'Scan libraries'}
        </button>
        {scanning && <div className="scan-progress truncate">{scanning}</div>}
        <button className="btn" onClick={props.onAddRoot}>
          Add library folder
        </button>
        <button className="btn" onClick={props.onAddGame}>
          Add single game
        </button>
        <button className="btn ghost" onClick={props.onStorage}>
          Storage
        </button>
        <button className="btn ghost" onClick={props.onSettings}>
          Settings
        </button>
      </div>
    </aside>
  )
}
