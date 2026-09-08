import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { store } from './store'
import type { VaultState } from '../shared/types'

const ITERATIONS = 210_000
const KEYLEN = 32
const DIGEST = 'sha512'

/**
 * Gate for the hidden section. This keeps hidden titles out of the UI behind a
 * password; it is not disk encryption, and the folders themselves stay readable
 * in Explorer.
 */
class Vault {
  /** Unlocked state lives only in memory, so it resets when the app closes. */
  private unlockedUntilQuit = false

  get state(): VaultState {
    if (!store.settings.vaultHash) return 'unset'
    return this.unlockedUntilQuit ? 'unlocked' : 'locked'
  }

  get isUnlocked(): boolean {
    return this.state === 'unlocked'
  }

  private derive(password: string, salt: string): Buffer {
    return pbkdf2Sync(password, Buffer.from(salt, 'hex'), ITERATIONS, KEYLEN, DIGEST)
  }

  setPassword(password: string): void {
    const salt = randomBytes(16).toString('hex')
    store.updateSettings({
      vaultSalt: salt,
      vaultHash: this.derive(password, salt).toString('hex')
    })
    this.unlockedUntilQuit = true
  }

  verify(password: string): boolean {
    const { vaultHash, vaultSalt } = store.settings
    if (!vaultHash || !vaultSalt) return false
    const attempt = this.derive(password, vaultSalt)
    const stored = Buffer.from(vaultHash, 'hex')
    if (attempt.length !== stored.length) return false
    return timingSafeEqual(attempt, stored)
  }

  unlock(password: string): boolean {
    if (!this.verify(password)) return false
    this.unlockedUntilQuit = true
    return true
  }

  lock(): void {
    this.unlockedUntilQuit = false
  }

  /** Changing the password requires proving you know the current one. */
  changePassword(current: string, next: string): boolean {
    if (!this.verify(current)) return false
    this.setPassword(next)
    return true
  }

  /** Removes the vault and un-hides everything it was covering. */
  disable(current: string): boolean {
    if (!this.verify(current)) return false
    for (const game of store.games) game.hidden = false
    store.updateSettings({ vaultHash: null, vaultSalt: null })
    this.unlockedUntilQuit = false
    return true
  }
}

export const vault = new Vault()
