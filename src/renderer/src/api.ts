import type { Api } from '../../preload/index'
import type { Game } from '../../shared/types'

declare global {
  interface Window {
    api: Api
  }
}

export const api = window.api

/**
 * Hours across every device, which is what a player means by "playtime".
 * Sync records each machine's own figure separately so two of them can never
 * overwrite each other, and this is where they are added back up.
 */
export function totalPlaytime(game: Game): number {
  const elsewhere = Object.values(game.remotePlaytime ?? {}).reduce((sum, s) => sum + s, 0)
  return game.playtimeSeconds + elsewhere
}

/** Just the part played on other machines, for showing the split. */
export function remotePlaytime(game: Game): number {
  return Object.values(game.remotePlaytime ?? {}).reduce((sum, s) => sum + s, 0)
}

export function formatPlaytime(seconds: number): string {
  if (seconds <= 0) return 'Never played'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`
  const hours = seconds / 3600
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`
}

export function formatDate(ts: number | null): string {
  if (!ts) return '—'
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(ts).toLocaleDateString()
}

export function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes > 1024 * 1024) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} KB`
}
