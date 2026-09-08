import { useState } from 'react'
import { api, formatSize } from '../api'
import type { ConflictChoice, SaveConflict } from '../../../shared/types'

interface Props {
  conflicts: SaveConflict[]
  onClose: () => void
  onToast: (message: string) => void
}

const when = (ts: number): string => new Date(ts).toLocaleString()

/**
 * Shown when the same game was played on two devices since the last sync. Both
 * saves exist on the server either way — this only decides which one this device
 * ends up holding.
 */
export default function ConflictDialog({ conflicts, onClose, onToast }: Props): JSX.Element {
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const conflict = conflicts[index]

  const choose = async (choice: ConflictChoice): Promise<void> => {
    setBusy(true)
    await api.resolveConflict(conflict.gameId, choice)
    setBusy(false)
    if (choice !== 'skip') {
      onToast(
        choice === 'local'
          ? `Kept this device's save for “${conflict.title}”.`
          : `Restored the ${conflict.remote.deviceName} save for “${conflict.title}”.`
      )
    }
    if (index + 1 < conflicts.length) setIndex(index + 1)
    else onClose()
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Save conflict</h2>
        <p className="dim">
          “{conflict.title}” was played on two devices since the last sync. Pick which save this
          device should keep — the other one stays on the server and in local backups, so nothing is
          lost either way.
        </p>

        <div className="conflict-side">
          <strong>This device</strong>
          <div className="dim">
            {when(conflict.local.capturedAt)} · {conflict.local.fileCount} files ·{' '}
            {formatSize(conflict.local.size)}
          </div>
          <button className="btn" disabled={busy} onClick={() => choose('local')}>
            Keep this one, upload it
          </button>
        </div>

        <div className="conflict-side">
          <strong>{conflict.remote.deviceName}</strong>
          <div className="dim">{when(conflict.remote.capturedAt)} · from the server</div>
          <button className="btn" disabled={busy} onClick={() => choose('remote')}>
            Take that one, replace mine
          </button>
        </div>

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
