import { useState } from 'react'
import { api, formatSize } from '../api'
import type { Game, SaveVersion } from '../../../shared/types'

interface Props {
  game: Game
  onToast: (message: string) => void
}

const when = (ts: number): string => new Date(ts).toLocaleString()

/**
 * Every save this game still has on the server. The versions were always kept —
 * uploading never overwrites — but there was no way to look at them, so they
 * only ever helped during a conflict. This makes them useful for the more
 * common case: a save that went wrong and a yesterday you would like back.
 */
export default function SaveHistory({ game, onToast }: Props): JSX.Element | null {
  const [versions, setVersions] = useState<SaveVersion[] | null>(null)
  const [busy, setBusy] = useState(false)

  if (game.savePaths.length === 0) return null

  const load = async (): Promise<void> => {
    setBusy(true)
    const list = await api.saveVersions(game.id)
    setBusy(false)
    setVersions(list)
    if (list.length === 0) onToast('No saves on the server for this game yet.')
  }

  const restore = async (version: SaveVersion): Promise<void> => {
    const ok = confirm(
      `Put back the save from ${version.deviceName}, ${when(version.capturedAt)}?\n\n` +
        `What is on disk now is copied to your local backups first, so this can be undone.`
    )
    if (!ok) return
    setBusy(true)
    const result = await api.restoreSaveVersion(game.id, version.versionId)
    setBusy(false)
    if (!result.ok) {
      onToast(result.error ?? 'Could not restore that save.')
      return
    }
    onToast(`Restored the save from ${when(version.capturedAt)}.`)
    void load()
  }

  return (
    <div className="field">
      <label>Save history</label>
      {versions === null ? (
        <button className="btn small" disabled={busy} onClick={load}>
          {busy ? 'Loading…' : 'Show versions on the server'}
        </button>
      ) : versions.length === 0 ? (
        <p className="dim small-text">Nothing stored yet — sync this game once.</p>
      ) : (
        <ul className="version-list">
          {versions.map((version) => (
            <li key={version.versionId} className={version.current ? 'current' : ''}>
              <span className="truncate">
                {when(version.capturedAt)}
                {version.current && <span className="badge-save">on this device</span>}
              </span>
              <span className="dim small-text">
                {version.deviceName} · {formatSize(version.size)}
              </span>
              {!version.current && (
                <button className="btn small" disabled={busy} onClick={() => restore(version)}>
                  Restore
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {versions !== null && versions.length > 0 && (
        <p className="dim small-text">
          The server keeps the last 20. Restoring backs up what you have now first.
        </p>
      )}
    </div>
  )
}
