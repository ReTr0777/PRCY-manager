import { app, BrowserWindow, protocol, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import * as launcher from './launcher'
import { store } from './store'
import { ensureDeviceIdentity } from './sync'

// Cover art lives anywhere on disk, and a renderer with contextIsolation cannot
// load file:// URLs. This scheme serves only paths the library already knows.
protocol.registerSchemesAsPrivileged([
  { scheme: 'gameimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

function isKnownImage(target: string): boolean {
  const key = path.resolve(target).toLowerCase()
  return store.games.some((g) => g.coverPath && path.resolve(g.coverPath).toLowerCase() === key)
}

/** electron-builder stamps the packaged exe itself; this is for the dev window. */
function windowIcon(): string | undefined {
  const candidate = path.join(app.getAppPath(), 'build', 'icon.ico')
  return fs.existsSync(candidate) ? candidate : undefined
}

function createWindow(): void {
  const win = new BrowserWindow({
    icon: windowIcon(),
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#12121a',
    title: 'PRCY Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  store.load()
  ensureDeviceIdentity()

  protocol.handle('gameimg', (request) => {
    const raw = new URL(request.url).searchParams.get('p')
    if (!raw) return new Response('missing path', { status: 400 })
    const target = decodeURIComponent(raw)
    if (!isKnownImage(target) || !fs.existsSync(target)) {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Credit any session still open when the app closes.
app.on('before-quit', () => launcher.shutdown())
