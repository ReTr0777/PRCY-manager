/**
 * Supervisor for the PRCY sync server.
 *
 * The server can replace its own code from the web UI. That is only safe if
 * something outside the running process decides what to start and can undo a
 * bad swap, which is what this file is for. It is deliberately tiny and is the
 * one part the server never updates, so it cannot break itself.
 *
 * Where the code comes from, in order:
 *   1. <PRCY_DATA>/server/index.js  — an applied update, on the data volume so
 *      it survives the container being recreated
 *   2. /app/index.js                — the version baked into the image
 *
 * A child that exits with code 75 is asking to be restarted (an update was
 * applied). A child that dies quickly and repeatedly is treated as a bad
 * update: the previous file comes back, and failing that the baked-in one.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const DATA = process.env.PRCY_DATA ?? path.join(process.cwd(), 'data')
const LIVE_DIR = path.join(DATA, 'server')

const BAKED = path.join(APP_DIR, 'index.js')
const LIVE = path.join(LIVE_DIR, 'index.js')
const PREVIOUS = path.join(LIVE_DIR, 'index.js.prev')

/** Exit code the server uses to ask for a restart after updating itself. */
const RESTART_CODE = 75
/** A start that fails sooner than this never really came up. */
const HEALTHY_AFTER_MS = 15_000
const MAX_FAST_FAILURES = 3

const log = (...args) => console.log('[launcher]', ...args)

function currentEntry() {
  if (fs.existsSync(LIVE)) return LIVE
  return BAKED
}

/**
 * Steps back one version after a failed start: the previous update first, the
 * image's own copy last. Returns false when there is nothing left to fall back
 * to, which means the baked-in server itself is failing and no swap will help.
 */
function rollBack() {
  if (fs.existsSync(LIVE) && fs.existsSync(PREVIOUS)) {
    log('rolling back to the previous update')
    fs.copyFileSync(PREVIOUS, LIVE)
    fs.rmSync(PREVIOUS, { force: true })
    return true
  }
  if (fs.existsSync(LIVE)) {
    log('discarding the update, falling back to the version in the image')
    fs.rmSync(LIVE, { force: true })
    fs.rmSync(path.join(LIVE_DIR, 'ui.html'), { force: true })
    return true
  }
  return false
}

let child = null
let stopping = false
let fastFailures = 0

function start() {
  const entry = currentEntry()
  log(`starting ${entry}`)
  const startedAt = Date.now()

  child = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: { ...process.env, PRCY_LAUNCHER: '1', PRCY_APP_DIR: APP_DIR }
  })

  child.on('exit', (code, signal) => {
    child = null
    if (stopping) return

    const alive = Date.now() - startedAt

    if (code === RESTART_CODE) {
      log('restart requested after an update')
      fastFailures = 0
      setTimeout(start, 250)
      return
    }

    if (alive < HEALTHY_AFTER_MS) {
      fastFailures++
      log(`server exited after ${alive} ms (code ${code}, signal ${signal}) — failure ${fastFailures}`)
      if (fastFailures >= MAX_FAST_FAILURES) {
        fastFailures = 0
        if (!rollBack()) {
          log('nothing left to roll back to; giving up so the container restarts')
          process.exit(1)
        }
      }
    } else {
      // It ran fine for a while, so this is a crash rather than a bad update.
      fastFailures = 0
      log(`server exited (code ${code}, signal ${signal}) — restarting`)
    }
    setTimeout(start, 1000)
  })
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true
    if (child) child.kill(signal)
    setTimeout(() => process.exit(0), 2000).unref()
  })
}

fs.mkdirSync(LIVE_DIR, { recursive: true })
start()
