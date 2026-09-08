import { useEffect, useState } from 'react'
import { api, formatSize } from '../api'
import type { AppUpdateStatus } from '../../../shared/types'

interface Props {
  onToast: (message: string) => void
}

/**
 * Updates come from the same server that holds the saves. Checking is manual on
 * open and automatic once per session, and installing is always a decision: the
 * app has to quit for Windows to replace its files, and nobody wants that to
 * happen mid-game.
 */
export default function AppUpdate({ onToast }: Props): JSX.Element {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [ready, setReady] = useState<string | null>(null)

  useEffect(() => {
    void check()
    return api.onAppUpdateProgress(({ received, total }) =>
      setProgress(total > 0 ? Math.round((received / total) * 100) : null)
    )
  }, [])

  const check = async (): Promise<void> => {
    setChecking(true)
    setStatus(await api.checkAppUpdate())
    setChecking(false)
  }

  const download = async (version: string): Promise<void> => {
    setProgress(0)
    const result = await api.downloadAppUpdate(version)
    setProgress(null)
    if (!result.ok || !result.file) {
      onToast(result.error ?? 'Download failed.')
      return
    }
    setReady(result.file)
  }

  return (
    <section>
      <h3>App updates</h3>
      <p className="dim">
        Builds are published to your own sync server with <code>npm run publish</code>, so every
        device that syncs can update itself from there. Nothing is downloaded from the internet.
      </p>

      <div className="row">
        <span className="dim">
          Running <strong>v{status?.current ?? '…'}</strong>
        </span>
        <button className="btn small" disabled={checking} onClick={check}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {status?.error && <p className="dim error">{status.error}</p>}

      {status && !status.error && !status.available && (
        <p className="dim">
          {status.behind
            ? `The server has v${status.behind}, which is older than this build.`
            : 'This is the newest build published to your server.'}
        </p>
      )}

      {status?.available && (
        <div className="update-card">
          <div>
            <strong>v{status.available.version} is available</strong>
            <div className="dim small-text">
              {formatSize(status.available.size)} · published{' '}
              {new Date(status.available.publishedAt).toLocaleDateString()}
            </div>
            {status.available.notes && <p className="dim">{status.available.notes}</p>}
          </div>

          {ready ? (
            <button
              className="btn primary"
              onClick={async () => {
                const result = await api.installAppUpdate(ready)
                if (!result.ok) onToast(result.error ?? 'Could not start the installer.')
              }}
            >
              Install and restart
            </button>
          ) : (
            <button
              className="btn"
              disabled={progress !== null}
              onClick={() => download(status.available!.version)}
            >
              {progress === null ? 'Download' : `Downloading ${progress}%`}
            </button>
          )}
        </div>
      )}

      {ready && (
        <p className="dim">
          The installer is downloaded and its checksum matched. Installing closes the app; it
          reopens on the new version once Windows is done.
        </p>
      )}
    </section>
  )
}
