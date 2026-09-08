/**
 * Renders the app mark to build/icon.ico and build/icon.png.
 *
 * Everything here is plain Node: shapes are signed distance fields sampled with
 * 4x4 supersampling, and the PNG/ICO containers are written by hand. That keeps
 * a native image dependency out of the project for something we run once.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

// --- geometry (all coordinates in a 256x256 design space) --------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r
  const qy = Math.abs(py - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/** Inigo Quilez's triangle SDF: distance to the nearest edge, signed by winding. */
function sdTriangle(px, py, a, b, c) {
  const e = [
    [b[0] - a[0], b[1] - a[1]],
    [c[0] - b[0], c[1] - b[1]],
    [a[0] - c[0], a[1] - c[1]]
  ]
  const v = [
    [px - a[0], py - a[1]],
    [px - b[0], py - b[1]],
    [px - c[0], py - c[1]]
  ]
  const s = Math.sign(e[0][0] * e[2][1] - e[0][1] * e[2][0])

  let minDistSq = Infinity
  let minSide = Infinity
  for (let i = 0; i < 3; i++) {
    const t = clamp((v[i][0] * e[i][0] + v[i][1] * e[i][1]) / (e[i][0] ** 2 + e[i][1] ** 2), 0, 1)
    const qx = v[i][0] - e[i][0] * t
    const qy = v[i][1] - e[i][1] * t
    minDistSq = Math.min(minDistSq, qx * qx + qy * qy)
    minSide = Math.min(minSide, s * (v[i][0] * e[i][1] - v[i][1] * e[i][0]))
  }
  return -Math.sqrt(minDistSq) * Math.sign(minSide)
}

/** Colour of one sample, or null where the mark is transparent. */
function sample(x, y) {
  // Tile: rounded square with a diagonal purple gradient.
  const tile = sdRoundRect(x, y, 128, 128, 120, 120, 58)
  if (tile > 0) return null

  const t = clamp((x + y) / 512, 0, 1)
  let r = Math.round(0x6f + (0xb0 - 0x6f) * t)
  let g = Math.round(0x6b + (0x5c - 0x6b) * t)
  let b = Math.round(0xff + (0xf5 - 0xff) * t)

  // A soft highlight along the top edge keeps the tile from looking flat.
  const sheen = clamp(1 - (x * 0.35 + y) / 300, 0, 1) * 0.16
  r += Math.round((255 - r) * sheen)
  g += Math.round((255 - g) * sheen)
  b += Math.round((255 - b) * sheen)

  // Play triangle, rounded by insetting the vertices and subtracting a radius.
  const tri = sdTriangle(x, y, [102, 76], [102, 164], [176, 120]) - 9
  // Shelf bar underneath: this is a library, not just a launcher.
  const bar = sdRoundRect(x, y, 128, 190, 44, 8, 8)

  if (tri < 0) return [255, 255, 255]
  if (bar < 0) return [255, 255, 255, 220]
  return [r, g, b]
}

function render(size) {
  const SS = 4
  const scale = 256 / size
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = (x + (sx + 0.5) / SS) * scale
          const dy = (y + (sy + 0.5) / SS) * scale
          const c = sample(dx, dy)
          if (!c) continue
          const ca = (c[3] ?? 255) / 255
          r += c[0] * ca
          g += c[1] * ca
          b += c[2] * ca
          a += ca
        }
      }
      const total = SS * SS
      const i = (y * size + x) * 4
      if (a > 0) {
        px[i] = Math.round(r / a)
        px[i + 1] = Math.round(g / a)
        px[i + 2] = Math.round(b / a)
        px[i + 3] = Math.round((a / total) * 255)
      }
    }
  }
  return px
}

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // Each scanline is prefixed with filter type 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- ICO ---------------------------------------------------------------------

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach((entry, i) => {
    const at = i * 16
    dir[at] = entry.size >= 256 ? 0 : entry.size
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size
    dir.writeUInt16LE(1, at + 4) // colour planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32LE(entry.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

// --- run ---------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true })
const entries = ICO_SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }))
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(entries))
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), entries.at(-1).png)
console.log(`wrote build/icon.ico (${ICO_SIZES.join(', ')}) and build/icon.png`)
