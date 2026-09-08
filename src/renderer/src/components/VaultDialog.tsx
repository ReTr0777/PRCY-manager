import { useState } from 'react'
import { api } from '../api'
import type { VaultState } from '../../../shared/types'

interface Props {
  vaultState: VaultState
  onClose: () => void
  onUnlocked: () => void
}

/** Handles both first-time setup and unlocking, since the flow is nearly identical. */
export default function VaultDialog({ vaultState, onClose, onUnlocked }: Props): JSX.Element {
  const setup = vaultState === 'unset'
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (setup) {
      if (password !== confirmPassword) return setError('The two passwords do not match.')
      const result = await api.vaultSetPassword(password)
      if (!result.ok) return setError(result.error ?? 'Could not set the password.')
      onUnlocked()
    } else {
      const result = await api.vaultUnlock(password)
      if (!result.ok) return setError(result.error ?? 'Wrong password.')
      onUnlocked()
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{setup ? 'Set a vault password' : 'Unlock hidden games'}</h2>
        <p className="dim">
          {setup
            ? 'Hidden games stay out of the library until you unlock the vault. The password is stored as a hash, so keep it somewhere safe — it cannot be recovered.'
            : 'The vault stays unlocked until you lock it or close the app.'}
        </p>

        <input
          type="password"
          autoFocus
          placeholder="Password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
            setError(null)
          }}
        />
        {setup && (
          <input
            type="password"
            placeholder="Repeat password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        )}

        {error && <div className="error">{error}</div>}
        {setup && (
          <div className="note">
            This hides titles inside the app. It does not encrypt the game folders themselves.
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={password.length < 4}>
            {setup ? 'Create vault' : 'Unlock'}
          </button>
        </div>
      </form>
    </div>
  )
}
