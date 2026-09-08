import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CoverCandidate, Game } from '../../../shared/types'

interface Props {
  game: Game
  hasSteamGridKey: boolean
  onClose: () => void
  onToast: (message: string) => void
}

export default function CoverSearchDialog({ game, hasSteamGridKey, onClose, onToast }: Props): JSX.Element {
  const [query, setQuery] = useState(game.title)
  const [results, setResults] = useState<CoverCandidate[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState<string | null>(null)
  // Not every app has a portrait capsule; drop tiles that fail to load rather
  // than paying for an existence check on every result up front.
  const [broken, setBroken] = useState<Set<string>>(new Set())
  // A slow search must not overwrite the results of a later one.
  const requestId = useRef(0)

  const search = async (term: string): Promise<void> => {
    const id = ++requestId.current
    setBusy(true)
    const found = await api.searchCovers(term)
    if (id !== requestId.current) return
    setBroken(new Set())
    setResults(found)
    setBusy(false)
  }

  useEffect(() => {
    search(game.title)
  }, [game.id])

  const apply = async (candidate: CoverCandidate): Promise<void> => {
    setApplying(candidate.thumbUrl)
    const file = await api.applyCover(game.id, candidate)
    setApplying(null)
    if (file) onClose()
    else onToast('That image could not be downloaded — try another.')
  }

  const visible = (results ?? []).filter((c) => !broken.has(c.thumbUrl))

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide covers" onClick={(e) => e.stopPropagation()}>
        <h2>Cover art for “{game.title}”</h2>

        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            search(query)
          }}
        >
          <input value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </form>

        <p className="dim">
          Searching Steam{hasSteamGridKey ? ' and SteamGridDB' : ''}. Try the exact store page
          title if nothing matches
          {hasSteamGridKey ? '.' : ', or add a SteamGridDB key in Settings for more art.'}
        </p>

        {results === null || busy ? (
          <div className="cover-empty">Searching…</div>
        ) : visible.length === 0 ? (
          <div className="cover-empty">No art found for that search.</div>
        ) : (
          <div className="cover-grid">
            {visible.map((candidate) => (
              <button
                key={`${candidate.source}-${candidate.thumbUrl}`}
                className={`cover-hit${applying === candidate.thumbUrl ? ' busy' : ''}`}
                title={`${candidate.title} — ${candidate.source}`}
                disabled={applying !== null}
                onClick={() => apply(candidate)}
              >
                <img
                  src={candidate.thumbUrl}
                  alt=""
                  loading="lazy"
                  onError={() => setBroken((prev) => new Set(prev).add(candidate.thumbUrl))}
                />
                <span className="truncate">{candidate.title}</span>
                <small className="dim">
                  {candidate.source}
                  {candidate.width ? ` · ${candidate.width}×${candidate.height}` : ''}
                </small>
              </button>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
