import { useEffect, useState } from 'react'
import { api, formatDate } from '../api'
import type {
  AppState,
  SaveConflict,
  SyncDevice,
  SyncServerInfo,
  TitleSuggestion
} from '../../../shared/types'

interface Props {
  state: AppState
  onToast: (message: string) => void
  onConflicts: (conflicts: SaveConflict[]) => void
  onMatches: (suggestions: TitleSuggestion[]) => void
}

export default function SyncSettings({ state, onToast, onConflicts, onMatches }: Props): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [info, setInfo] = useState<SyncServerInfo | null>(null)
  const [creating, setCreating] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [devices, setDevices] = useState<SyncDevice[] | null>(null)
  const { settings } = state
  const signedIn = Boolean(settings.syncUrl && settings.syncToken)

  useEffect(() => api.onSyncProgress(({ message }) => setProgress(message)), [])

  // Ask the server what it offers, so the form can show a sign-up option only
  // where one exists rather than failing after the fact.
  useEffect(() => {
    if (!settings.syncUrl) {
      setInfo(null)
      return
    }
    let live = true
    api.syncServerInfo(settings.syncUrl).then((result) => live && setInfo(result))
    return () => {
      live = false
    }
  }, [settings.syncUrl])

  useEffect(() => {
    if (signedIn) api.syncDevices().then(setDevices)
    else setDevices(null)
  }, [signedIn])

  const run = async (): Promise<void> => {
    setBusy('Syncing…')
    const result = await api.syncNow()
    setBusy(null)
    setProgress(null)
    if (!result.ok) {
      onToast(result.error ?? 'Sync failed.')
      return
    }
    const parts: string[] = []
    if (result.metadataChanged) parts.push(`${result.metadataChanged} updated`)
    if (result.savesUploaded) parts.push(`${result.savesUploaded} saves up`)
    if (result.savesDownloaded) parts.push(`${result.savesDownloaded} saves down`)
    if (result.coversUploaded) parts.push(`${result.coversUploaded} covers up`)
    if (result.coversDownloaded) parts.push(`${result.coversDownloaded} covers down`)
    onToast(`Sync finished — ${parts.length ? parts.join(', ') : 'already up to date'}`)
    if (result.conflicts.length > 0) onConflicts(result.conflicts)
    if (result.suggestions.length > 0) onMatches(result.suggestions)
  }

  const submitSignIn = async (): Promise<void> => {
    setBusy(creating ? 'Creating…' : 'Signing in…')
    const result = await api.syncSignIn(
      username.trim(),
      password,
      creating ? invite.trim() : undefined
    )
    setBusy(null)
    if (!result.ok) {
      onToast(result.error ?? 'Sign-in failed.')
      return
    }
    setPassword('')
    setInvite('')
    onToast(`Signed in as ${result.username}.`)
  }

  return (
    <section>
      <h3>Cross-device sync</h3>
      <p className="dim">
        Point every device at your own server (see <code>server/</code> in the project) and they
        share saves, playtime, covers and the hidden vault. One server can hold several accounts,
        each with its own separate library. Saves are versioned there, so nothing is overwritten
        beyond recovery.
      </p>

      <label className="field-row">
        <span>Server</span>
        <input
          placeholder="https://prcy.example.com"
          defaultValue={settings.syncUrl ?? ''}
          onBlur={(e) => api.updateSettings({ syncUrl: e.target.value.trim() || null })}
        />
      </label>
      {info && !info.ok && <p className="dim error">{info.error}</p>}
      {info?.ok && info.accounts === false && (
        <p className="dim error">
          That server predates accounts. Update the copy in <code>server/</code> on your Unraid box.
        </p>
      )}

      {!signedIn && settings.syncUrl && (
        <>
          <label className="field-row">
            <span>Account</span>
            <input
              placeholder="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="field-row">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitSignIn()}
            />
          </label>
          {creating && (
            <label className="field-row">
              <span>Invite code</span>
              <input
                type="password"
                placeholder="PRCY_INVITE_CODE from the server"
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
              />
            </label>
          )}
          <div className="row">
            <button
              className="btn primary"
              disabled={busy !== null || !username.trim() || !password}
              onClick={submitSignIn}
            >
              {busy ?? (creating ? 'Create account' : 'Sign in')}
            </button>
            {info?.registrationOpen && (
              <button className="btn" onClick={() => setCreating(!creating)}>
                {creating ? 'I already have an account' : 'Create an account'}
              </button>
            )}
          </div>
          <p className="dim">
            The password is used once, to get a token for this device. It is never stored here, and
            signing a device out revokes only that device.
          </p>
        </>
      )}

      {signedIn && (
        <>
          <div className="row">
            <span className="dim">
              Signed in as <strong>{settings.syncUsername ?? 'unknown'}</strong>
            </span>
            <button
              className="btn small"
              onClick={async () => {
                await api.syncSignOut()
                onToast('Signed out on this device.')
              }}
            >
              Sign out
            </button>
          </div>

          <label className="field-row">
            <span>This device</span>
            <input
              placeholder="desktop"
              defaultValue={settings.deviceName}
              onBlur={(e) => api.updateSettings({ deviceName: e.target.value.trim() || 'device' })}
            />
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={settings.syncOnPlay}
              onChange={(e) => api.updateSettings({ syncOnPlay: e.target.checked })}
            />
            Sync a game's saves automatically when you finish playing
          </label>

          <div className="row">
            <button
              className="btn"
              disabled={busy !== null}
              onClick={async () => {
                setBusy('Testing…')
                const result = await api.testSync()
                setBusy(null)
                onToast(result.ok ? 'Server reachable and signed in.' : result.error ?? 'Failed.')
              }}
            >
              Test connection
            </button>
            <button className="btn primary" disabled={busy !== null} onClick={run}>
              {busy ?? 'Sync now'}
            </button>
            <span className="dim">
              {settings.lastSyncAt ? `Last sync ${formatDate(settings.lastSyncAt)}` : 'Never synced'}
            </span>
          </div>
          {progress && <div className="scan-progress truncate">{progress}</div>}

          {devices && devices.length > 1 && (
            <ul className="root-list">
              {devices.map((device) => (
                <li key={device.id}>
                  <span>{device.deviceName}</span>
                  <span className="path">
                    {device.current ? 'this device' : `last seen ${formatDate(device.lastSeen)}`}
                  </span>
                  {!device.current && (
                    <button
                      className="btn small danger"
                      onClick={async () => {
                        await api.syncRevokeDevice(device.id)
                        setDevices(await api.syncDevices())
                      }}
                    >
                      Sign out
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="dim">
            A game only syncs saves once it has a save location set, on its detail panel. Large save
            sets are uploaded in pieces, so they get through a proxy that limits request size.
          </p>
        </>
      )}
    </section>
  )
}
