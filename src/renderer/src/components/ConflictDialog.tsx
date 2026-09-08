import { useState } from 'react'
import { api, formatSize } from '../api'
import type { ConflictChoice, SaveConflict, SaveSide } from '../../../shared/types'

interface Props {
  conflicts: SaveConflict[]
  onClose: () => void
  onToast: (message: string) => void
}

const when = (ts: number): string => (ts ? new Date(ts).toLocaleString() : 'unknown')

/** "3 hours", "2 days" — how far apart the two saves are. */
function gap(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} min`
  const hours = minutes / 60
  if (hours < 48) return `${Math.round(hours)} h`
  return `${Math.round(hours / 24)} days`
}

/**
 * Shown when the same game was played on two devices since the last sync. Both
 * saves exist on the server either way — this only decides which one this device
 * ends up holding. The file-by-file comparison is the point: "newer" and
 * "bigger" are the only evidence anything generic can offer about progress.
 */
export default function ConflictDialog({ conflicts, onClose, onToast }: Props): JSX.Element {
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [showFiles, setShowFiles] = useState(true)
  const conflict = conflicts[index]

  const { local, remote } = conflict
  const localNewer = local.newestFileAt > remote.newestFileAt
  const difference = Math.abs(local.newestFileAt - remote.newestFileAt)
  const comparable = local.newestFileAt > 0 && remote.newestFileAt > 0

  const choose = async (choice: ConflictChoice): Promise<void> => {
    setBusy(true)
    await api.resolveConflict(conflict.gameId, choice)
    setBusy(false)
    if (choice !== 'skip') {
      onToast(
        choice === 'local'
          ? `Kept this device's save for “${conflict.title}”.`
          : `Restored the ${remote.deviceName} save for “${conflict.title}”.`
      )
    }
    if (index + 1 < conflicts.length) setIndex(index + 1)
    else onClose()
  }

  const summary = (s: SaveSide): string =>
    `${s.fileCount} file${s.fileCount === 1 ? '' : 's'} · ${formatSize(s.size)}`

  return (
    <div className="modal-backdrop">
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Save conflict — {conflict.title}</h2>
        <p className="dim">
          Played on two devices since the last sync. Pick which save this device should keep — the
          other one stays on the server and in local backups, so nothing is lost either way.
        </p>

        {comparable && (
          <p className="verdict">
            {difference < 60_000 ? (
              <>Both saves were written at about the same time.</>
            ) : (
              <>
                The <strong>{localNewer ? 'local' : remote.deviceName}</strong> save is{' '}
                <strong>{gap(difference)}</strong> newer.
              </>
            )}
          </p>
        )}

        <div className="conflict-grid">
          <div className={`conflict-side${localNewer && comparable ? ' newer' : ''}`}>
            <strong>This device</strong>
            <div className="dim small-text">last written {when(local.newestFileAt)}</div>
            <div className="dim small-text">{summary(local)}</div>
            <button className="btn" disabled={busy} onClick={() => choose('local')}>
              Keep this one, upload it
            </button>
          </div>

          <div className={`conflict-side${!localNewer && comparable ? ' newer' : ''}`}>
            <strong>{remote.deviceName}</strong>
            <div className="dim small-text">
              {remote.fileCount > 0
                ? `last written ${when(remote.newestFileAt)}`
                : `uploaded ${when(remote.capturedAt)}`}
            </div>
            <div className="dim small-text">
              {remote.fileCount > 0 ? summary(remote) : 'could not read it — offer stands anyway'}
            </div>
            <button className="btn" disabled={busy} onClick={() => choose('remote')}>
              Take that one, replace mine
            </button>
          </div>
        </div>

        {conflict.files.length > 0 && (
          <>
            <button className="btn small ghost" onClick={() => setShowFiles(!showFiles)}>
              {showFiles ? 'Hide' : 'Show'} the files
            </button>
            {showFiles && (
              <table className="diff-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th className="num">Here</th>
                    <th className="num">{remote.deviceName}</th>
                  </tr>
                </thead>
                <tbody>
                  {conflict.files.map((file) => {
                    const l = file.local
                    const r = file.remote
                    const newer = l && r ? (l.mtime > r.mtime ? 'local' : r.mtime > l.mtime ? 'remote' : '') : ''
                    return (
                      <tr key={file.path}>
                        <td className="truncate" title={file.path}>
                          {file.path}
                        </td>
                        <td className={`num${newer === 'local' ? ' newer-cell' : ''}`}>
                          {l ? (
                            <>
                              {formatSize(l.size)}
                              <span className="dim small-text"> · {when(l.mtime)}</span>
                            </>
                          ) : (
                            <span className="dim">missing</span>
                          )}
                        </td>
                        <td className={`num${newer === 'remote' ? ' newer-cell' : ''}`}>
                          {r ? (
                            <>
                              {formatSize(r.size)}
                              <span className="dim small-text"> · {when(r.mtime)}</span>
                            </>
                          ) : (
                            <span className="dim">missing</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {showFiles && conflict.moreFiles > 0 && (
              <p className="dim small-text">and {conflict.moreFiles} more, older still</p>
            )}
          </>
        )}

        <div className="modal-actions">
          <span className="dim">
            {index + 1} of {conflicts.length}
          </span>
          <button className="btn ghost" disabled={busy} onClick={() => choose('skip')}>
            Decide later
          </button>
        </div>
      </div>
    </div>
  )
}
