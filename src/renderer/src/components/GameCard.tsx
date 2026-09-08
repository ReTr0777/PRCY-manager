import { api, formatPlaytime, totalPlaytime } from '../api'
import type { Game } from '../../../shared/types'

interface Props {
  game: Game
  running: boolean
  selected: boolean
  onSelect: () => void
  onLaunch: () => void
}

/** Deterministic tint so a game without art still looks like itself every time. */
function tint(title: string): string {
  let hash = 0
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) % 360
  return `linear-gradient(150deg, hsl(${hash} 45% 32%), hsl(${(hash + 40) % 360} 40% 18%))`
}

export default function GameCard({ game, running, selected, onSelect, onLaunch }: Props): JSX.Element {
  return (
    <div
      className={`card${selected ? ' selected' : ''}${game.missing ? ' missing' : ''}`}
      onClick={onSelect}
      onDoubleClick={onLaunch}
    >
      <div className="art" style={game.coverPath ? undefined : { background: tint(game.title) }}>
        {game.coverPath ? (
          // Art arrives in both shapes — Steam's portrait capsules and itch's
          // landscape ones — so fit the whole image and fill the gap with a
          // blurred copy of itself rather than cropping either one.
          <>
            <img className="art-blur" src={api.imageUrl(game.coverPath)} alt="" aria-hidden="true" />
            <img className="art-fit" src={api.imageUrl(game.coverPath)} alt="" loading="lazy" />
          </>
        ) : (
          <span className="initials">{game.title.slice(0, 2).toUpperCase()}</span>
        )}

        {running && <span className="chip running">Running</span>}
        {game.missing && <span className="chip warn">Folder missing</span>}
        {game.favorite && <span className="star">★</span>}

        <button
          className="play"
          title={game.exePath ? 'Launch' : 'No executable set'}
          disabled={!game.exePath || game.missing || running}
          onClick={(e) => {
            e.stopPropagation()
            onLaunch()
          }}
        >
          ▶
        </button>
      </div>

      <div className="card-body">
        <div className="card-title truncate" title={`${game.title}\n${game.folder}`}>
          {game.title}
        </div>
        <div className="card-meta">{formatPlaytime(totalPlaytime(game))}</div>
      </div>
    </div>
  )
}
