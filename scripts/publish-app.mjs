/**
 * Uploads the built Windows installer to your own sync server, which is where
 * the desktop app looks for updates.
 *
 *   PRCY_URL=http://100.81.73.7:8787 PRCY_ADMIN_TOKEN=… npm run publish
 *
 * It goes up in chunks for the same reason saves do: the server caps a single
 * request so the same upload works through a proxy that does too.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const url = (process.env.PRCY_URL ?? '').replace(/\/+$/, '')
const token = process.env.PRCY_ADMIN_TOKEN ?? ''
const notes = process.env.PRCY_NOTES ?? ''
const version = process.env.PRCY_VERSION ?? pkg.version

if (!url || !token) {
  console.error('Set PRCY_URL and PRCY_ADMIN_TOKEN.')
  console.error('e.g. PRCY_URL=http://100.81.73.7:8787 PRCY_ADMIN_TOKEN=abc… npm run publish')
  process.exit(1)
}

const installer = path.join(root, 'dist', `${pkg.build.productName} Setup ${pkg.version}.exe`)
if (!fs.existsSync(installer)) {
  console.error(`No installer at ${installer} — run "npm run dist" first.`)
  process.exit(1)
}

const call = async (method, route, options = {}) => {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body && !options.raw ? { 'Content-Type': 'application/json' } : {}),
      ...(options.raw ? { 'Content-Type': 'application/octet-stream' } : {})
    },
    body: options.raw ?? (options.body ? JSON.stringify(options.body) : undefined)
  })
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { error: text.slice(0, 200) }
  }
  if (!response.ok) throw new Error(json.error ?? `${route} returned ${response.status}`)
  return json
}

const health = await call('GET', '/health').catch((err) => {
  console.error(`Cannot reach ${url} — ${err.message}`)
  process.exit(1)
})

const data = fs.readFileSync(installer)
const sha = createHash('sha256').update(data).digest('hex')
const chunkSize = health.maxBodyBytes ?? 8 * 1024 * 1024
const megabytes = (data.length / 1024 / 1024).toFixed(1)
console.log(`Publishing ${path.basename(installer)} (${megabytes} MB) as v${version}`)

const { uploadId } = await call('POST', '/v1/uploads', { body: {} })
let sent = 0
for (let index = 0; sent < data.length; index++) {
  const part = data.subarray(sent, sent + chunkSize)
  await call('PUT', `/v1/uploads/${uploadId}/${index}`, { raw: part })
  sent += part.length
  process.stdout.write(`\r  ${Math.round((sent / data.length) * 100)}%   `)
}

const release = await call('POST', `/v1/uploads/${uploadId}/finish`, {
  body: { target: { kind: 'app', version, notes } }
})
console.log('\nPublished.')
console.log(`  version ${release.version}, ${(release.size / 1024 / 1024).toFixed(1)} MB`)
console.log(`  sha256  ${release.sha256}`)
if (release.sha256 !== sha) {
  console.error('  WARNING: the server hashed different bytes than were sent.')
  process.exit(1)
}
console.log('Every signed-in device will offer this on its next check.')
