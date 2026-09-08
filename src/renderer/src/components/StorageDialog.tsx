import { useEffect, useMemo, useState } from 'react'
import { api, formatDate, formatPlaytime, formatSize, totalPlaytime } from '../api'
import type { AppState, Game, StorageReport } from '../../../shared/types'

interface Props {
  state: AppState
  onClose: () => void
  onToast: (message: string) => void
}

type Filter = 'all' | 'unplayed'

export default function StorageDialog({ state, onClose, onToast }: Props): JSX.Element {
  const [report, setReport] = useState<StorageReport | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState(false)

  const refresh = (): Promise<void> => api.storageReport().then(setReport)

  useEffect(() => {
    void refresh()
    return api.onStorageProgress(({ done, total, title }) =>
      setProgress(`${done}/${total} — ${title}`)
    )
  }, [])

  const measure = async (all: boolean): Promise<void> => {
    setBusy(true)
    setProgress('Starting…')
    const result = await api.measureStorage(all)
    setBusy(false)
    setProgress(null)
    await refresh()
    onToast(`Measured ${result.measured} games — ${formatSize(result.bytes)} in total.`)
  }

  // Biggest first: the whole point of the screen is deciding what to remove.
  const ranked = useMemo(() => {
    const list = state.games.filter((g) => !g.missing && typeof g.sizeBytes === 'number')
    const filtered = filter === 'unplayed' ? list.filter((g) => totalPlaytime(g) === 0) : list
    return [...filtered].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
  }, [state.games, filter])

  const rankedTotal = ranked.reduce((sum, g) => sum + (g.sizeBytes ?? 0), 0)

  const remove = async (game: Game): Promise<void> => {
    const size = game.sizeBytes ? ` (${formatSize(game.sizeBytes)})` : ''
    const ok = confirm(
      `Delete the files for “${game.title}”${size}?\n\n${game.folder}\n\nThe folder goes to the Recycle Bin and the game leaves your library. Saves already synced to your server are not touched.`
    )
    if (!ok) return
    const result = await api.deleteGameFiles(game.id)
    if (!result.ok) {
      onToast(result.error ?? 'Could not delete that folder.')
      return
    }
    await refresh()
    onToast(`Deleted ${game.title} — ${formatSize(result.freed)} freed.`)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Storage on this device</h2>
        <p className="dim">
          Sizes are measured from the folders on this machine and are never synced — deleting a game
          here frees space here, and your other devices keep their own copies.
        </p>

        {report === null ? (
          <p className="dim">Measuring…</p>
        ) : (
          <>
            <section>
              <h3>Drives</h3>
              {report.drives.length === 0 && <p className="dim">No games on disk yet.</p>}
              {report.drives.map((drive) => {
                const used = drive.totalBytes - drive.freeBytes
                const gamePct = drive.totalBytes ? (drive.gameBytes / drive.totalBytes) * 100 : 0
                const otherPct = drive.totalBytes
                  ? Math.max(0, ((used - drive.gameBytes) / drive.totalBytes) * 100)
                  : 0
                return (
                  <div className="drive" key={drive.drive}>
                    <div className="drive-head">
                      <strong>{drive.drive}</strong>
                      <span className="dim">
                        {drive.online
                          ? `${formatSize(drive.freeBytes)} free of ${formatSize(drive.totalBytes)}`
                          : 'offline'}
                      </span>
                    </div>
                    <div className="drive-bar" title={`${formatSize(drive.gameBytes)} of games`}>
                      <span className="games" style={{ width: `${gamePct}%` }} />
                      <span className="other" style={{ width: `${otherPct}%` }} />
                    </div>
                    <div className="drive-legend dim">
                      <span>
                        <i className="swatch games" /> {drive.gameCount} games,{' '}
                        {formatSize(drive.gameBytes)}
                        {drive.measuredCount < drive.gameCount &&
                          ` (${drive.gameCount - drive.measuredCount} not measured)`}
                      </span>
                      <span>
                        <i className="swatch other" /> everything else
                      </span>
                    </div>
                  </div>
                )
              })}

              <div className="row">
                <button className="btn" disabled={busy} onClick={() => measure(false)}>
                  {report.unmeasured > 0
                    ? `Measure ${report.unmeasured} new games`
                    : 'Measure new games'}
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => measure(true)}>
                  Re-measure everything
                </button>
              </div>
              {progress && <div className="scan-progress truncate">{progress}</div>}
            </section>

            <section>
              <div className="row space">
                <h3>Biggest games</h3>
                <div className="row">
                  <button
                    className={`btn small${filter === 'all' ? ' primary' : ''}`}
                    onClick={() => setFilter('all')}
                  >
                    All
                  </button>
                  <button
                    className={`btn small${filter === 'unplayed' ? ' primary' : ''}`}
                    onClick={() => setFilter('unplayed')}
                  >
                    Never played
                  </button>
                </div>
              </div>
              <p className="dim">
                {ranked.length} games, {formatSize(rankedTotal)}
                {filter === 'unplayed' && ' — installed but never started'}
              </p>

              {ranked.length === 0 ? (
                <p className="dim">Nothing measured yet.</p>
              ) : (
                <ul className="size-list">
                  {ranked.map((game) => (
                    <li key={game.id}>
                      <span className="truncate" title={game.folder}>
                        {game.title}
                      </span>
                      <span className="dim small-text">
                        {totalPlaytime(game) > 0
                          ? formatPlaytime(totalPlaytime(game))
                          : 'never played'}
                        {game.lastPlayed ? ` · ${formatDate(game.lastPlayed)}` : ''}
                      </span>
                      <span className="size">{formatSize(game.sizeBytes ?? 0)}</span>
                      <button className="btn small" onClick={() => api.openFolder(game.id)}>
                        Open
                      </button>
                      <button className="btn small danger" onClick={() => remove(game)}>
                        Delete files
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3>The app's own files</h3>
              <p className="path truncate" title={report.app.userDataPath}>
                {report.app.userDataPath}
              </p>
              <ul className="size-list">
                <li>
                  <span>Library file</span>
                  <span className="dim small-text">titles, playtime, tags</span>
                  <span className="size">{formatSize(report.app.libraryBytes)}</span>
                </li>
                <li>
                  <span>Cover art</span>
                  <span className="dim small-text">{report.app.coverCount} images</span>
                  <span className="size">{formatSize(report.app.coverBytes)}</span>
                  <button
                    className="btn small"
                    onClick={async () => {
                      const result = await api.pruneCovers()
                      await refresh()
                      onToast(
                        result.removed
                          ? `Removed ${result.removed} unused covers — ${formatSize(result.freed)} freed.`
                          : 'No unused covers to remove.'
                      )
                    }}
                  >
                    Remove unused
                  </button>
                </li>
                <li>
                  <span>Save backups</span>
                  <span className="dim small-text">
                    {report.app.backupCount} kept from sync conflicts
                  </span>
                  <span className="size">{formatSize(report.app.backupBytes)}</span>
                  <button
                    className="btn small"
                    onClick={async () => {
                      const result = await api.trimBackups(30)
                      await refresh()
                      onToast(
                        result.removed
                          ? `Removed ${result.removed} backups older than 30 days — ${formatSize(result.freed)} freed.`
                          : 'No backups older than 30 days.'
                      )
                    }}
                  >
                    Trim over 30 days
                  </button>
                </li>
              </ul>
            </section>
          </>
        )}

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
