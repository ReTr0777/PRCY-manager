/**
 * PRCY Manager sync server.
 *
 * Deliberately dependency-free: it is one file on top of node:http, so the
 * container is just `node:22-alpine` plus this script and nothing to audit or
 * update.
 *
 * Several people can share one server. Each account gets its own library, its
 * own saves and its own conflict history; only the cover-art blob store is
 * shared, since it is content-addressed public artwork and sharing it means one
 * copy of a capsule image instead of one per person.
 *
 *   PRCY_ADMIN_TOKEN=<secret> PRCY_DATA=/data node index.js
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const PORT = Number(process.env.PRCY_PORT ?? 8787)
const DATA = process.env.PRCY_DATA ?? path.join(process.cwd(), 'data')
const ADMIN_TOKEN = process.env.PRCY_ADMIN_TOKEN ?? ''
const INVITE_CODE = process.env.PRCY_INVITE_CODE ?? ''

/**
 * The largest body accepted in one request. Anything bigger has to arrive as
 * chunks. The default is well under the 100 MB request limit that Cloudflare
 * imposes on its free and Pro plans, so the same upload works whether it is
 * reached over the LAN or through a proxy.
 */
const CHUNK_LIMIT = Math.max(1, Number(process.env.PRCY_CHUNK_MB ?? 8)) * 1024 * 1024
/** Ceiling for an assembled upload, i.e. one game's whole save set. */
const MAX_ASSEMBLED = Math.max(1, Number(process.env.PRCY_MAX_UPLOAD_MB ?? 2048)) * 1024 * 1024

const USERS_FILE = path.join(DATA, 'users.json')
const TOKENS_FILE = path.join(DATA, 'tokens.json')
const BLOBS_DIR = path.join(DATA, 'blobs')
const UPLOADS_DIR = path.join(DATA, 'uploads')
const USERS_DIR = path.join(DATA, 'u')

if (!ADMIN_TOKEN) {
  console.error('Refusing to start without PRCY_ADMIN_TOKEN set.')
  process.exit(1)
}

for (const dir of [DATA, BLOBS_DIR, UPLOADS_DIR, USERS_DIR]) fs.mkdirSync(dir, { recursive: true })
// Half-finished uploads from a previous run are worthless; nobody can resume one.
fs.rmSync(UPLOADS_DIR, { recursive: true, force: true })
fs.mkdirSync(UPLOADS_DIR, { recursive: true })

// --- helpers -----------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? {}))
  res.writeHead(status, {
    'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
    'Content-Length': payload.length,
    // Saves and covers are private and change; a proxy must never keep a copy.
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(payload)
}

/** Constant-time compare that does not leak the length of the secret. */
function secretMatches(given, want) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest()
  const b = crypto.createHash('sha256').update(String(want ?? '')).digest()
  return crypto.timingSafeEqual(a, b)
}

const bearer = (header) => String(header ?? '').replace(/^Bearer\s+/i, '')

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        // Stop reading but leave the socket up, so the 413 actually reaches the
        // client instead of arriving as a reset it has to guess the meaning of.
        req.pause()
        reject(Object.assign(new Error(`body too large; the limit is ${limit} bytes per request`), {
          status: 413,
          closeAfterReply: true
        }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const raw = (await readBody(req, limit)).toString('utf8')
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

/** Keeps a path segment from escaping its directory. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/
const SAFE_HASH = /^[a-f0-9]{64}$/
const SAFE_USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2))
  await fsp.rename(tmp, file)
}

const emptyLibrary = () => ({ rev: 0, updatedAt: 0, games: {}, vault: null })

// --- accounts ----------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT)
  return { salt, hash: key.toString('hex') }
}

function passwordMatches(password, user) {
  const key = crypto.scryptSync(password, user.salt, SCRYPT.keylen, SCRYPT)
  const want = Buffer.from(user.hash, 'hex')
  return key.length === want.length && crypto.timingSafeEqual(key, want)
}

const loadUsers = () => readJson(USERS_FILE, { users: [] })
const loadTokens = () => readJson(TOKENS_FILE, { tokens: {} })
const tokenId = (token) => crypto.createHash('sha256').update(token).digest('hex')

/** Serialises the read-modify-write of the two account files. */
let accountLock = Promise.resolve()
function withAccounts(fn) {
  const next = accountLock.then(fn, fn)
  accountLock = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

async function createUser(username, password, { admin = false } = {}) {
  const name = String(username ?? '').trim().toLowerCase()
  if (!SAFE_USERNAME.test(name)) {
    throw Object.assign(new Error('username must be 2-32 characters: a-z 0-9 . _ -'), { status: 400 })
  }
  if (String(password ?? '').length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), { status: 400 })
  }
  return withAccounts(async () => {
    const db = await loadUsers()
    if (db.users.some((u) => u.username === name)) {
      throw Object.assign(new Error('that username is taken'), { status: 409 })
    }
    const { salt, hash } = hashPassword(password)
    const user = {
      id: crypto.randomBytes(12).toString('hex'),
      username: name,
      salt,
      hash,
      admin,
      createdAt: Date.now()
    }
    db.users.push(user)
    await writeJsonAtomic(USERS_FILE, db)
    await fsp.mkdir(path.join(USERS_DIR, user.id, 'saves'), { recursive: true })
    return user
  })
}

async function issueToken(user, deviceName) {
  const token = crypto.randomBytes(32).toString('hex')
  await withAccounts(async () => {
    const db = await loadTokens()
    db.tokens[tokenId(token)] = {
      userId: user.id,
      deviceName: String(deviceName ?? 'device').slice(0, 64),
      createdAt: Date.now(),
      lastSeen: Date.now()
    }
    await writeJsonAtomic(TOKENS_FILE, db)
  })
  return token
}

/** Resolves a bearer token to its account, or null. */
async function authenticate(header) {
  const token = bearer(header)
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  const tokens = await loadTokens()
  const entry = tokens.tokens[tokenId(token)]
  if (!entry) return null
  const db = await loadUsers()
  const user = db.users.find((u) => u.id === entry.userId)
  if (!user) return null
  return { user, session: entry, tokenId: tokenId(token) }
}

/**
 * Password guessing is the weak point of any account system, so failures are
 * counted per username and per source address and both have to stay under the
 * limit. Successes clear the counter.
 */
const failures = new Map()
const FAIL_WINDOW = 15 * 60 * 1000
const FAIL_LIMIT = 10

function throttled(...keys) {
  const now = Date.now()
  return keys.some((key) => {
    const entry = failures.get(key)
    return entry && now - entry.first < FAIL_WINDOW && entry.count >= FAIL_LIMIT
  })
}

function noteFailure(...keys) {
  const now = Date.now()
  for (const key of keys) {
    const entry = failures.get(key)
    if (!entry || now - entry.first > FAIL_WINDOW) failures.set(key, { first: now, count: 1 })
    else entry.count++
  }
}

const clearFailures = (...keys) => keys.forEach((key) => failures.delete(key))

const userPaths = (user) => ({
  library: path.join(USERS_DIR, user.id, 'library.json'),
  saves: path.join(USERS_DIR, user.id, 'saves')
})

// --- auth routes -------------------------------------------------------------

async function register(req, res, ip) {
  const body = await readJsonBody(req)
  if (!INVITE_CODE) {
    return send(res, 403, { error: 'Registration is closed on this server. Ask the owner for an account.' })
  }
  if (throttled(`ip:${ip}`)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' })
  if (!secretMatches(body.code, INVITE_CODE)) {
    noteFailure(`ip:${ip}`)
    return send(res, 403, { error: 'Wrong invite code.' })
  }
  const user = await createUser(body.username, body.password)
  clearFailures(`ip:${ip}`)
  const token = await issueToken(user, body.deviceName)
  send(res, 200, { token, username: user.username, userId: user.id })
}

async function login(req, res, ip) {
  const body = await readJsonBody(req)
  const name = String(body.username ?? '').trim().toLowerCase()
  if (throttled(`ip:${ip}`, `user:${name}`)) {
    return send(res, 429, { error: 'Too many failed logins. Wait 15 minutes.' })
  }
  const db = await loadUsers()
  const user = db.users.find((u) => u.username === name)
  // Hash even when the user does not exist, so a missing account and a wrong
  // password take the same time and cannot be told apart.
  const password = String(body.password ?? '')
  const ok = user
    ? passwordMatches(password, user)
    : (hashPassword(password, 'absent-account-decoy-salt'), false)
  if (!ok) {
    noteFailure(`ip:${ip}`, `user:${name}`)
    return send(res, 401, { error: 'Wrong username or password.' })
  }
  clearFailures(`ip:${ip}`, `user:${name}`)
  const token = await issueToken(user, body.deviceName)
  send(res, 200, { token, username: user.username, userId: user.id })
}

async function logout(res, auth) {
  await withAccounts(async () => {
    const db = await loadTokens()
    delete db.tokens[auth.tokenId]
    await writeJsonAtomic(TOKENS_FILE, db)
  })
  send(res, 200, { ok: true })
}

async function listDevices(res, auth) {
  const db = await loadTokens()
  const devices = Object.entries(db.tokens)
    .filter(([, t]) => t.userId === auth.user.id)
    .map(([id, t]) => ({
      id: id.slice(0, 12),
      deviceName: t.deviceName,
      createdAt: t.createdAt,
      lastSeen: t.lastSeen,
      current: id === auth.tokenId
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen)
  send(res, 200, { devices })
}

/** Signs one device out, addressed by the short id from the device list. */
async function revokeDevice(res, auth, shortId) {
  await withAccounts(async () => {
    const db = await loadTokens()
    for (const [id, t] of Object.entries(db.tokens)) {
      if (t.userId === auth.user.id && id.startsWith(shortId)) delete db.tokens[id]
    }
    await writeJsonAtomic(TOKENS_FILE, db)
  })
  send(res, 200, { ok: true })
}

async function changePassword(req, res, auth) {
  const body = await readJsonBody(req)
  if (!passwordMatches(String(body.current ?? ''), auth.user)) {
    return send(res, 401, { error: 'Wrong current password.' })
  }
  if (String(body.next ?? '').length < 8) {
    return send(res, 400, { error: 'password must be at least 8 characters' })
  }
  await withAccounts(async () => {
    const db = await loadUsers()
    const user = db.users.find((u) => u.id === auth.user.id)
    Object.assign(user, hashPassword(String(body.next)))
    await writeJsonAtomic(USERS_FILE, db)

    // Every other device keeps working only if it holds its own token, which it
    // does — but a password change should still end sessions the user may be
    // trying to cut off, so all except this one go.
    const tokens = await loadTokens()
    for (const [id, t] of Object.entries(tokens.tokens)) {
      if (t.userId === auth.user.id && id !== auth.tokenId) delete tokens.tokens[id]
    }
    await writeJsonAtomic(TOKENS_FILE, tokens)
  })
  send(res, 200, { ok: true })
}

// --- admin routes ------------------------------------------------------------

async function adminList(res) {
  const db = await loadUsers()
  const tokens = await loadTokens()
  send(res, 200, {
    users: db.users.map((u) => ({
      username: u.username,
      id: u.id,
      admin: u.admin,
      createdAt: u.createdAt,
      devices: Object.values(tokens.tokens).filter((t) => t.userId === u.id).length
    }))
  })
}

async function adminCreate(req, res) {
  const body = await readJsonBody(req)
  const user = await createUser(body.username, body.password, { admin: Boolean(body.admin) })
  send(res, 200, { username: user.username, id: user.id })
}

async function adminDelete(res, username) {
  const name = String(username).toLowerCase()
  const removed = await withAccounts(async () => {
    const db = await loadUsers()
    const user = db.users.find((u) => u.username === name)
    if (!user) return null
    db.users = db.users.filter((u) => u.id !== user.id)
    await writeJsonAtomic(USERS_FILE, db)
    const tokens = await loadTokens()
    for (const [id, t] of Object.entries(tokens.tokens)) {
      if (t.userId === user.id) delete tokens.tokens[id]
    }
    await writeJsonAtomic(TOKENS_FILE, tokens)
    return user
  })
  if (!removed) return send(res, 404, { error: 'no such user' })
  // The account's library and saves go with it; shared blobs stay, since other
  // accounts may reference the same artwork.
  await fsp.rm(path.join(USERS_DIR, removed.id), { recursive: true, force: true })
  send(res, 200, { ok: true, username: name })
}

async function adminResetPassword(req, res, username) {
  const body = await readJsonBody(req)
  if (String(body.password ?? '').length < 8) {
    return send(res, 400, { error: 'password must be at least 8 characters' })
  }
  const done = await withAccounts(async () => {
    const db = await loadUsers()
    const user = db.users.find((u) => u.username === String(username).toLowerCase())
    if (!user) return false
    Object.assign(user, hashPassword(String(body.password)))
    await writeJsonAtomic(USERS_FILE, db)
    const tokens = await loadTokens()
    for (const [id, t] of Object.entries(tokens.tokens)) {
      if (t.userId === user.id) delete tokens.tokens[id]
    }
    await writeJsonAtomic(TOKENS_FILE, tokens)
    return true
  })
  send(res, done ? 200 : 404, done ? { ok: true } : { error: 'no such user' })
}

// --- library -----------------------------------------------------------------

/** GET /v1/library — this account's metadata document. */
async function getLibrary(res, user) {
  send(res, 200, await readJson(userPaths(user).library, emptyLibrary()))
}

/**
 * PUT /v1/library — replace the document. The client sends the rev it started
 * from; a mismatch means another device wrote first, so the current document
 * comes back with 409 and the client merges again. That keeps merging in one
 * place (the client) while the server stays a dumb, consistent store.
 */
async function putLibrary(req, res, user) {
  const body = await readJsonBody(req, CHUNK_LIMIT)
  const file = userPaths(user).library
  const current = await readJson(file, emptyLibrary())

  if (typeof body.baseRev === 'number' && body.baseRev !== current.rev) {
    return send(res, 409, { error: 'revision conflict', current })
  }

  const next = {
    rev: current.rev + 1,
    updatedAt: Date.now(),
    games: body.games ?? {},
    vault: body.vault ?? null
  }
  await writeJsonAtomic(file, next)
  send(res, 200, { rev: next.rev, updatedAt: next.updatedAt })
}

// --- saves -------------------------------------------------------------------

/** GET /v1/saves/:key — every stored version of one game's saves, newest first. */
async function listSaves(res, user, key) {
  const dir = path.join(userPaths(user).saves, key)
  const meta = await readJson(path.join(dir, 'versions.json'), { versions: [] })
  meta.versions.sort((a, b) => b.capturedAt - a.capturedAt)
  send(res, 200, meta)
}

/**
 * Stores a new version. Old versions are kept (capped), so a device that
 * uploads over someone else's save never destroys it.
 */
async function storeSave(user, key, body, { deviceId, deviceName, capturedAt }) {
  const dir = path.join(userPaths(user).saves, key)
  await fsp.mkdir(dir, { recursive: true })
  const hash = crypto.createHash('sha256').update(body).digest('hex')
  const versionId = `${Date.now().toString(36)}-${hash.slice(0, 8)}`
  await fsp.writeFile(path.join(dir, `${versionId}.prcysave`), body)

  const metaFile = path.join(dir, 'versions.json')
  const meta = await readJson(metaFile, { versions: [] })
  meta.versions.push({
    versionId,
    hash,
    deviceId: deviceId ?? 'unknown',
    deviceName: deviceName ?? deviceId ?? 'unknown',
    size: body.length,
    capturedAt: capturedAt || Date.now()
  })

  // Keep the most recent 20 versions per game; drop the files for the rest.
  meta.versions.sort((a, b) => b.capturedAt - a.capturedAt)
  const dropped = meta.versions.splice(20)
  for (const old of dropped) {
    await fsp.rm(path.join(dir, `${old.versionId}.prcysave`), { force: true })
  }
  await writeJsonAtomic(metaFile, meta)
  return { versionId, hash, size: body.length }
}

async function putSave(req, res, user, key) {
  const url = new URL(req.url, 'http://x')
  const body = await readBody(req, CHUNK_LIMIT)
  if (body.length === 0) return send(res, 400, { error: 'empty body' })
  const stored = await storeSave(user, key, body, {
    deviceId: url.searchParams.get('device'),
    deviceName: url.searchParams.get('name'),
    capturedAt: Number(url.searchParams.get('capturedAt'))
  })
  send(res, 200, stored)
}

/** GET /v1/saves/:key/:versionId — one archive, streamed. */
async function getSave(res, user, key, versionId) {
  const file = path.join(userPaths(user).saves, key, `${versionId}.prcysave`)
  try {
    const stat = await fsp.stat(file)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    })
    fs.createReadStream(file).pipe(res)
  } catch {
    send(res, 404, { error: 'no such version' })
  }
}

// --- blobs -------------------------------------------------------------------

/** Content-addressed store for cover art, shared between accounts. */
async function headBlob(res, hash) {
  try {
    const stat = await fsp.stat(path.join(BLOBS_DIR, hash))
    res.writeHead(200, { 'Content-Length': stat.size, 'Cache-Control': 'no-store' })
    res.end()
  } catch {
    res.writeHead(404)
    res.end()
  }
}

async function getBlob(res, hash) {
  try {
    send(res, 200, await fsp.readFile(path.join(BLOBS_DIR, hash)))
  } catch {
    send(res, 404, { error: 'no such blob' })
  }
}

async function storeBlob(hash, body) {
  const actual = crypto.createHash('sha256').update(body).digest('hex')
  // The name is the hash, so a mismatch means corruption in transit.
  if (actual !== hash) throw Object.assign(new Error('hash mismatch'), { status: 400 })
  await fsp.writeFile(path.join(BLOBS_DIR, hash), body)
  return { hash, size: body.length }
}

async function putBlob(req, res, hash) {
  send(res, 200, await storeBlob(hash, await readBody(req, CHUNK_LIMIT)))
}

// --- chunked uploads ---------------------------------------------------------

/**
 * Anything larger than one request's limit arrives in parts. This exists
 * because proxies cap request bodies — Cloudflare's free and Pro plans refuse
 * anything over 100 MB — and a big save set would otherwise be undeliverable
 * from outside the LAN. Parts are written straight to disk and concatenated on
 * finish, so memory use stays flat regardless of the total size.
 */
async function beginUpload(res, user) {
  const uploadId = crypto.randomBytes(12).toString('hex')
  await fsp.mkdir(path.join(UPLOADS_DIR, uploadId), { recursive: true })
  await writeJsonAtomic(path.join(UPLOADS_DIR, uploadId, 'meta.json'), {
    userId: user.id,
    startedAt: Date.now()
  })
  send(res, 200, { uploadId, chunkSize: CHUNK_LIMIT })
}

async function uploadDir(uploadId, user) {
  if (!SAFE_SEGMENT.test(uploadId)) throw Object.assign(new Error('bad upload id'), { status: 400 })
  const dir = path.join(UPLOADS_DIR, uploadId)
  const meta = await readJson(path.join(dir, 'meta.json'), null)
  if (!meta) throw Object.assign(new Error('no such upload'), { status: 404 })
  if (meta.userId !== user.id) throw Object.assign(new Error('no such upload'), { status: 404 })
  return dir
}

async function putChunk(req, res, user, uploadId, index) {
  if (!/^\d{1,5}$/.test(index)) return send(res, 400, { error: 'bad chunk index' })
  const dir = await uploadDir(uploadId, user)
  const body = await readBody(req, CHUNK_LIMIT)
  await fsp.writeFile(path.join(dir, `${index.padStart(5, '0')}.part`), body)
  send(res, 200, { index: Number(index), size: body.length })
}

async function finishUpload(req, res, user, uploadId) {
  const dir = await uploadDir(uploadId, user)
  const body = await readJsonBody(req)
  const parts = (await fsp.readdir(dir)).filter((n) => n.endsWith('.part')).sort()
  if (parts.length === 0) return send(res, 400, { error: 'no chunks uploaded' })

  let total = 0
  for (const part of parts) total += (await fsp.stat(path.join(dir, part))).size
  if (total > MAX_ASSEMBLED) {
    await fsp.rm(dir, { recursive: true, force: true })
    return send(res, 413, { error: 'upload too large' })
  }

  const assembled = Buffer.concat(
    await Promise.all(parts.map((part) => fsp.readFile(path.join(dir, part))))
  )
  await fsp.rm(dir, { recursive: true, force: true })

  const target = body.target ?? {}
  if (target.kind === 'save') {
    if (!SAFE_SEGMENT.test(String(target.key ?? ''))) return send(res, 400, { error: 'bad key' })
    return send(
      res,
      200,
      await storeSave(user, target.key, assembled, {
        deviceId: target.deviceId,
        deviceName: target.deviceName,
        capturedAt: Number(target.capturedAt)
      })
    )
  }
  if (target.kind === 'blob') {
    if (!SAFE_HASH.test(String(target.hash ?? ''))) return send(res, 400, { error: 'bad hash' })
    return send(res, 200, await storeBlob(target.hash, assembled))
  }
  send(res, 400, { error: 'unknown upload target' })
}

/** Abandoned uploads would otherwise sit in /data forever. */
setInterval(
  () => {
    void (async () => {
      const cutoff = Date.now() - 60 * 60 * 1000
      for (const name of await fsp.readdir(UPLOADS_DIR).catch(() => [])) {
        const meta = await readJson(path.join(UPLOADS_DIR, name, 'meta.json'), null)
        if (!meta || meta.startedAt < cutoff) {
          await fsp.rm(path.join(UPLOADS_DIR, name), { recursive: true, force: true })
        }
      }
    })()
  },
  15 * 60 * 1000
).unref()

// --- server ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x')
    const ip = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'unknown')

    if (pathname === '/health') {
      const db = await loadUsers()
      return send(res, 200, {
        ok: true,
        service: 'prcy-sync',
        accounts: true,
        registrationOpen: Boolean(INVITE_CODE),
        hasUsers: db.users.length > 0,
        // The client reads this and splits anything bigger into chunks.
        maxBodyBytes: CHUNK_LIMIT
      })
    }

    const parts = pathname.split('/').filter(Boolean)
    if (parts[0] !== 'v1') return send(res, 404, { error: 'not found' })

    // Unauthenticated: getting in.
    if (parts[1] === 'auth' && parts.length === 3) {
      if (parts[2] === 'register' && req.method === 'POST') return await register(req, res, ip)
      if (parts[2] === 'login' && req.method === 'POST') return await login(req, res, ip)
    }

    // The admin token is a separate credential and never stands in for a user.
    if (parts[1] === 'admin') {
      if (!secretMatches(bearer(req.headers.authorization), ADMIN_TOKEN)) {
        return send(res, 401, { error: 'unauthorized' })
      }
      if (parts[2] === 'users' && parts.length === 3) {
        if (req.method === 'GET') return await adminList(res)
        if (req.method === 'POST') return await adminCreate(req, res)
      }
      if (parts[2] === 'users' && parts.length === 4 && req.method === 'DELETE') {
        return await adminDelete(res, parts[3])
      }
      if (parts[2] === 'users' && parts[4] === 'password' && req.method === 'POST') {
        return await adminResetPassword(req, res, parts[3])
      }
      return send(res, 404, { error: 'not found' })
    }

    const auth = await authenticate(req.headers.authorization)
    if (!auth) return send(res, 401, { error: 'unauthorized' })
    const user = auth.user

    if (parts[1] === 'auth') {
      if (parts[2] === 'me' && req.method === 'GET') {
        return send(res, 200, {
          username: user.username,
          userId: user.id,
          deviceName: auth.session.deviceName
        })
      }
      if (parts[2] === 'logout' && req.method === 'POST') return await logout(res, auth)
      if (parts[2] === 'password' && req.method === 'POST') return await changePassword(req, res, auth)
      if (parts[2] === 'devices' && parts.length === 3 && req.method === 'GET') {
        return await listDevices(res, auth)
      }
      if (parts[2] === 'devices' && parts.length === 4 && req.method === 'DELETE') {
        if (!SAFE_SEGMENT.test(parts[3])) return send(res, 400, { error: 'bad device' })
        return await revokeDevice(res, auth, parts[3])
      }
    }

    if (parts[1] === 'library' && parts.length === 2) {
      if (req.method === 'GET') return await getLibrary(res, user)
      if (req.method === 'PUT') return await putLibrary(req, res, user)
    }

    if (parts[1] === 'saves' && parts[2]) {
      if (!SAFE_SEGMENT.test(parts[2])) return send(res, 400, { error: 'bad key' })
      if (parts.length === 3) {
        if (req.method === 'GET') return await listSaves(res, user, parts[2])
        if (req.method === 'POST') return await putSave(req, res, user, parts[2])
      }
      if (parts.length === 4 && req.method === 'GET') {
        if (!SAFE_SEGMENT.test(parts[3])) return send(res, 400, { error: 'bad version' })
        return await getSave(res, user, parts[2], parts[3])
      }
    }

    if (parts[1] === 'blobs' && parts.length === 3) {
      if (!SAFE_HASH.test(parts[2])) return send(res, 400, { error: 'bad hash' })
      if (req.method === 'HEAD') return await headBlob(res, parts[2])
      if (req.method === 'GET') return await getBlob(res, parts[2])
      if (req.method === 'PUT') return await putBlob(req, res, parts[2])
    }

    if (parts[1] === 'uploads') {
      if (parts.length === 2 && req.method === 'POST') return await beginUpload(res, user)
      if (parts.length === 4 && parts[3] === 'finish' && req.method === 'POST') {
        return await finishUpload(req, res, user, parts[2])
      }
      if (parts.length === 4 && req.method === 'PUT') {
        return await putChunk(req, res, user, parts[2], parts[3])
      }
    }

    send(res, 404, { error: 'not found' })
  } catch (err) {
    const status = err?.status ?? 500
    if (status >= 500) console.error('[prcy-sync]', err)
    send(res, status, { error: String(err?.message ?? err) })
    // A rejected upload is still streaming; hang up once the reply is out
    // rather than reading gigabytes we are going to throw away.
    if (err?.closeAfterReply) res.on('finish', () => req.destroy())
  }
})

// Uploading a multi-gigabyte save over a slow link must not trip the idle timer.
server.requestTimeout = 0
server.headersTimeout = 60_000

server.listen(PORT, async () => {
  const db = await loadUsers()
  console.log(`prcy-sync listening on :${PORT}, data in ${DATA}`)
  console.log(`${db.users.length} account(s); registration ${INVITE_CODE ? 'open with invite code' : 'closed'}`)
  console.log(`max body ${Math.round(CHUNK_LIMIT / 1024 / 1024)} MB per request, larger uploads are chunked`)
})
