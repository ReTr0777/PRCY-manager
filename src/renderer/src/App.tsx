import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import Sidebar from './components/Sidebar'
import GameCard from './components/GameCard'
import GameDetail from './components/GameDetail'
import VaultDialog from './components/VaultDialog'
import SettingsDialog from './components/SettingsDialog'
import StorageDialog from './components/StorageDialog'
import ConflictDialog from './components/ConflictDialog'
import Toast from './components/Toast'
import type { AppState, Game, SaveConflict } from '../../shared/types'

export type View = { kind: 'all' | 'favorites' | 'recent' | 'unplayed' | 'hidden' | 'missing' } | { kind: 'root'; id: string }

const EMPTY: AppState = {
  games: [],
  roots: [],
  settings: {
    vaultHash: null,
    vaultSalt: null,
    minimizeOnLaunch: false,
    minSessionSeconds: 10,
    steamGridDbKey: null,
    sortBy: 'title',
    syncUrl: null,
    syncToken: null,
    syncUsername: null,
    deviceId: '',
    deviceName: '',
    syncOnPlay: true,
    lastSyncAt: null
  },
  vault: 'unset',
  running: []
}

export default function App(): JSX.Element {
  const [state, setState] = useState<AppState>(EMPTY)
  const [view, setView] = useState<View>({ kind: 'all' })
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scanning, setScanning] = useState<string | null>(null)
  const [showVault, setShowVault] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showStorage, setShowStorage] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<SaveConflict[]>([])

  useEffect(() => {
    api.getState().then(setState)
    const offState = api.onStateChanged(setState)
    const offRunning = api.onRunningChanged((running) => setState((s) => ({ ...s, running })))
    const offProgress = api.onScanProgress((name) => setScanning(name))
    return () => {
      offState()
      offRunning()
      offProgress()
    }
  }, [])

  const scan = useCallback(async () => {
    setScanning('Starting…')
    const report = await api.scan()
    setScanning(null)
    const parts = [`${report.added} new`, `${report.updated} updated`]
    if (report.missing) parts.push(`${report.missing} missing`)
    if (report.ignored) {
      // Name a few, so a folder skipped by mistake is noticeable rather than silent.
      const shown = report.ignoredNames.slice(0, 3).join(', ')
      const rest = report.ignored - Math.min(3, report.ignoredNames.length)
      parts.push(`skipped ${report.ignored} non-games (${shown}${rest > 0 ? `, +${rest}` : ''})`)
    }
    if (report.skippedRoots.length) parts.push(`offline: ${report.skippedRoots.join(', ')}`)
    setToast(`Scan finished — ${parts.join(', ')}`)
  }, [])

  const running = useMemo(() => new Set(state.running.map((r) => r.gameId)), [state.running])

  const games = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = state.games.filter((g) => {
      // Hidden games only ever show in their own view, never mixed into the library.
      if (view.kind === 'hidden') return g.hidden
      if (g.hidden) return false
      switch (view.kind) {
        case 'favorites':
          return g.favorite
        case 'recent':
          return g.lastPlayed !== null
        case 'unplayed':
          return g.playtimeSeconds === 0
        case 'missing':
          return g.missing
        case 'root':
          return g.rootId === view.id
        default:
          return true
      }
    })

    if (q) {
      list = list.filter(
        (g) => g.title.toLowerCase().includes(q) || g.tags.some((t) => t.toLowerCase().includes(q))
      )
    }

    const sorted = [...list]
    if (view.kind === 'recent') sorted.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
    else
      switch (state.settings.sortBy) {
        case 'lastPlayed':
          sorted.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
          break
        case 'playtime':
          sorted.sort((a, b) => b.playtimeSeconds - a.playtimeSeconds)
          break
        case 'addedAt':
          sorted.sort((a, b) => b.addedAt - a.addedAt)
          break
        case 'size':
          // Unmeasured games sort last rather than pretending to be empty.
          sorted.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1))
          break
        default:
          sorted.sort((a, b) => a.title.localeCompare(b.title))
      }
    return sorted
  }, [state.games, state.settings.sortBy, view, query])

  const selected: Game | null = useMemo(
    () => state.games.find((g) => g.id === selectedId) ?? null,
    [state.games, selectedId]
  )

  const launch = useCallback(async (id: string) => {
    const result = await api.launch(id)
    if (!result.ok) setToast(result.error ?? 'Could not launch that game.')
  }, [])

  const openHidden = useCallback(() => {
    if (state.vault === 'unlocked') setView({ kind: 'hidden' })
    else setShowVault(true)
  }, [state.vault])

  return (
    <div className="app">
      <Sidebar
        state={state}
        view={view}
        onView={setView}
        onOpenHidden={openHidden}
        onScan={scan}
        scanning={scanning}
        onAddRoot={async () => {
          const { added } = await api.addRoot()
          if (added) scan()
        }}
        onAddGame={async () => {
          const { added } = await api.addGameFolder()
          if (added) setToast(`Added ${added} game${added > 1 ? 's' : ''}.`)
        }}
        onSettings={() => setShowSettings(true)}
        onStorage={() => setShowStorage(true)}
        onLock={async () => {
          await api.vaultLock()
          setView({ kind: 'all' })
        }}
      />

      <main className="main">
        <header className="topbar">
          <input
            className="search"
            placeholder="Search your library…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="sort"
            value={state.settings.sortBy}
            onChange={(e) => api.updateSettings({ sortBy: e.target.value as never })}
          >
            <option value="title">Title</option>
            <option value="lastPlayed">Last played</option>
            <option value="playtime">Playtime</option>
            <option value="addedAt">Recently added</option>
            <option value="size">Size on disk</option>
          </select>
          <span className="count">{games.length} games</span>
        </header>

        {games.length === 0 ? (
          <EmptyState hasRoots={state.roots.length > 0} view={view} />
        ) : (
          <div className="grid">
            {games.map((game) => (
              <GameCard
                key={game.id}
                game={game}
                running={running.has(game.id)}
                selected={game.id === selectedId}
                onSelect={() => setSelectedId(game.id)}
                onLaunch={() => launch(game.id)}
              />
            ))}
          </div>
        )}
      </main>

      {selected && (
        <GameDetail
          game={selected}
          running={running.has(selected.id)}
          vaultState={state.vault}
          hasSteamGridKey={Boolean(state.settings.steamGridDbKey)}
          onClose={() => setSelectedId(null)}
          onLaunch={() => launch(selected.id)}
          onNeedVault={() => setShowVault(true)}
          onToast={setToast}
        />
      )}

      {showVault && (
        <VaultDialog
          vaultState={state.vault}
          onClose={() => setShowVault(false)}
          onUnlocked={() => {
            setShowVault(false)
            setView({ kind: 'hidden' })
          }}
        />
      )}

      {showStorage && (
        <StorageDialog state={state} onClose={() => setShowStorage(false)} onToast={setToast} />
      )}

      {showSettings && (
        <SettingsDialog
          state={state}
          onClose={() => setShowSettings(false)}
          onToast={setToast}
          onConflicts={setConflicts}
        />
      )}

      {conflicts.length > 0 && (
        <ConflictDialog
          conflicts={conflicts}
          onClose={() => setConflicts([])}
          onToast={setToast}
        />
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  )
}

function EmptyState({ hasRoots, view }: { hasRoots: boolean; view: View }): JSX.Element {
  if (view.kind === 'hidden') {
    return (
      <div className="empty">
        <h2>Nothing hidden yet</h2>
        <p>Open a game and switch on “Hide in vault” to move it here.</p>
      </div>
    )
  }
  return (
    <div className="empty">
      <h2>{hasRoots ? 'No games match' : 'No library folders yet'}</h2>
      <p>
        {hasRoots
          ? 'Try a different filter, or run a scan to pick up new downloads.'
          : 'Add a folder that holds your downloaded games, then scan. It can hold other things too — anything without a program inside is skipped.'}
      </p>
    </div>
  )
}
