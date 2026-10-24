// Visual comparison of screenshots between two runs — the other half of taking them.
//
// A scenario's screenshot records what the window looked like; nothing says whether it looks the
// same as last time. Checks that measure numbers (contrast, geometry, counts) stay green through
// changes that only show as a picture: a theme that paints the wrong background, a panel that grew,
// a control that lost its style. This compares two folders of screenshots pixel by pixel and says
// how many pictures it could actually compare — "nothing changed" over three comparable pairs out of
// four hundred is not a clean result.
//
// Dependency-free: PNG is read and written with node:zlib, for the 8-bit RGB/RGBA non-interlaced
// files a browser screenshot produces. Anything else is refused by name rather than guessed at.
// Which folder is the baseline, and when to replace it, is the caller's: this only compares.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

/**
 * @typedef {{ width: number, height: number, rgba: Uint8Array }} RgbaImage
 *   `rgba` is width × height × 4 bytes, row-major.
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 * @typedef {{
 *   width: number, height: number, changedPixels: number, totalPixels: number, ratio: number,
 *   box: Box | null, overlay: RgbaImage,
 * }} PixelDiff
 *   `ratio` = changedPixels / totalPixels; `box` holds every changed pixel (null when none changed);
 *   `overlay` is the newer picture dimmed with the changed pixels painted magenta, for a person.
 * @typedef {{ name: string, kind: 'identical' }
 *   | { name: string, kind: 'changed', ratio: number, changedPixels: number, box: Box }
 *   | { name: string, kind: 'resized', before: string, after: string }
 *   | { name: string, kind: 'unreadable', reason: string }} PairVerdict
 * @typedef {{
 *   common: number, compared: number, onlyBefore: string[], onlyAfter: string[], verdicts: PairVerdict[],
 * }} RunComparison
 *   `common` = pictures present in both folders, the denominator every other number is out of;
 *   `compared` = of those, how many could be compared pixel by pixel; `verdicts` most changed first.
 */

export class UnsupportedPngError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`PNG not supported: ${reason}`)
    this.name = 'UnsupportedPngError'
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** @param {number} a @param {number} b @param {number} c */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** @param {Uint8Array} buf @returns {RgbaImage} */
export function decodePng(buf) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.length < 8 || !b.subarray(0, 8).equals(SIGNATURE)) throw new UnsupportedPngError('not a PNG signature')
  let pos = 8
  let width = 0
  let height = 0
  let colorType = -1
  const idat = []
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos)
    const type = b.toString('latin1', pos + 4, pos + 8)
    const data = b.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]
      colorType = data[9]
      const interlace = data[12]
      if (bitDepth !== 8) throw new UnsupportedPngError(`bit depth ${bitDepth}`)
      if (colorType !== 2 && colorType !== 6) throw new UnsupportedPngError(`color type ${colorType}`)
      if (interlace !== 0) throw new UnsupportedPngError('interlaced')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (width === 0 || height === 0) throw new UnsupportedPngError('missing IHDR')
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length < height * (stride + 1)) throw new UnsupportedPngError('truncated image data')

  const out = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    const filter = raw[rowStart]
    for (let x = 0; x < stride; x++) {
      const v = raw[rowStart + 1 + x]
      const left = x >= channels ? cur[x - channels] : 0
      const up = prev[x]
      const upLeft = x >= channels ? prev[x - channels] : 0
      let r
      switch (filter) {
        case 0: r = v; break
        case 1: r = v + left; break
        case 2: r = v + up; break
        case 3: r = v + ((left + up) >> 1); break
        case 4: r = v + paeth(left, up, upLeft); break
        default: throw new UnsupportedPngError(`filter type ${filter} on row ${y}`)
      }
      cur[x] = r & 0xff
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      out[d] = cur[s]
      out[d + 1] = cur[s + 1]
      out[d + 2] = cur[s + 2]
      out[d + 3] = channels === 4 ? cur[s + 3] : 255
    }
    prev.set(cur)
  }
  return { width, height, rgba: out }
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData) >>> 0)
  return Buffer.concat([len, typeAndData, crc])
}

/**
 * An RGBA PNG. `filter` picks one row filter for every row (0–4); only tests have a reason to pass it.
 * @param {RgbaImage} img @param {0 | 1 | 2 | 3 | 4} [filter]
 */
export function encodePng(img, filter = 0) {
  const { width, height, rgba } = img
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = filter
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x]
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0
      const upLeft = y > 0 && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0
      const pred = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft)
      raw[rowStart + 1 + x] = (v - pred) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * Compares two same-sized images. A pixel counts as changed when any channel moves by more than
 * `tolerance` (0–255) — font smoothing and compositing jitter by a few levels between otherwise
 * identical renders. Returns null when the sizes differ: those are not the same picture to compare.
 * @param {RgbaImage} before @param {RgbaImage} after @param {number} [tolerance]
 * @returns {PixelDiff | null}
 */
export function diffImages(before, after, tolerance = 16) {
  if (before.width !== after.width || before.height !== after.height) return null
  const { width, height } = after
  const overlay = new Uint8Array(after.rgba.length)
  let changed = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let i = 0, p = 0; i < after.rgba.length; i += 4, p++) {
    const moved =
      Math.abs(before.rgba[i] - after.rgba[i]) > tolerance ||
      Math.abs(before.rgba[i + 1] - after.rgba[i + 1]) > tolerance ||
      Math.abs(before.rgba[i + 2] - after.rgba[i + 2]) > tolerance ||
      Math.abs(before.rgba[i + 3] - after.rgba[i + 3]) > tolerance
    if (moved) {
      changed++
      const x = p % width
      const y = (p - x) / width
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      overlay[i] = 255
      overlay[i + 1] = 0
      overlay[i + 2] = 255
      overlay[i + 3] = 255
    } else {
      overlay[i] = after.rgba[i] >> 2
      overlay[i + 1] = after.rgba[i + 1] >> 2
      overlay[i + 2] = after.rgba[i + 2] >> 2
      overlay[i + 3] = 255
    }
  }
  const totalPixels = width * height
  return {
    width,
    height,
    changedPixels: changed,
    totalPixels,
    ratio: totalPixels === 0 ? 0 : changed / totalPixels,
    box: changed === 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    overlay: { width, height, rgba: overlay },
  }
}

/**
 * Names present in both lists and in only one, each sorted.
 * @param {readonly string[]} before @param {readonly string[]} after
 */
export function pairNames(before, after) {
  const a = new Set(before)
  const b = new Set(after)
  return {
    common: [...a].filter((n) => b.has(n)).sort(),
    onlyBefore: [...a].filter((n) => !b.has(n)).sort(),
    onlyAfter: [...b].filter((n) => !a.has(n)).sort(),
  }
}

/**
 * One verdict for one pair of screenshots, given their bytes.
 * @param {string} name @param {Uint8Array} before @param {Uint8Array} after @param {number} [tolerance]
 * @returns {{ verdict: PairVerdict, diff: PixelDiff | null }}
 */
export function comparePair(name, before, after, tolerance = 16) {
  let a
  let b
  try {
    a = decodePng(before)
    b = decodePng(after)
  } catch (err) {
    return { verdict: { name, kind: 'unreadable', reason: /** @type {Error} */ (err).message }, diff: null }
  }
  const diff = diffImages(a, b, tolerance)
  if (diff === null) {
    return { verdict: { name, kind: 'resized', before: `${a.width}x${a.height}`, after: `${b.width}x${b.height}` }, diff: null }
  }
  if (diff.changedPixels === 0) return { verdict: { name, kind: 'identical' }, diff }
  return { verdict: { name, kind: 'changed', ratio: diff.ratio, changedPixels: diff.changedPixels, box: /** @type {Box} */ (diff.box) }, diff }
}

/**
 * Folds per-pair verdicts into the run-level numbers, keeping the denominator explicit.
 * @param {ReturnType<typeof pairNames>} pairs @param {PairVerdict[]} verdicts
 * @returns {RunComparison}
 */
export function summarizeRun(pairs, verdicts) {
  const weight = (v) => (v.kind === 'changed' ? v.ratio : -1)
  return {
    common: pairs.common.length,
    compared: verdicts.filter((v) => v.kind === 'identical' || v.kind === 'changed').length,
    onlyBefore: pairs.onlyBefore,
    onlyAfter: pairs.onlyAfter,
    verdicts: [...verdicts].sort((x, y) => weight(y) - weight(x)),
  }
}

/** @param {string} dir */
function pngsIn(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')) : []
}

/**
 * Compares the PNG files of two folders by name. With `out`, writes `<name>.diff.png` there for every
 * changed picture and `summary.json` with the result — the folder is created only when something is
 * written.
 * @param {string} before @param {string} after
 * @param {{ tolerance?: number, out?: string }} [options]
 * @returns {RunComparison}
 */
export function compareFolders(before, after, { tolerance = 16, out } = {}) {
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) throw new Error(`tolerance must be a whole number 0–255 — got ${tolerance}`)
  const pairs = pairNames(pngsIn(before), pngsIn(after))
  const verdicts = []
  for (const name of pairs.common) {
    const { verdict, diff } = comparePair(name, readFileSync(join(before, name)), readFileSync(join(after, name)), tolerance)
    verdicts.push(verdict)
    if (out && verdict.kind === 'changed' && diff) {
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, name.replace(/\.png$/i, '.diff.png')), encodePng(diff.overlay))
    }
  }
  const run = summarizeRun(pairs, verdicts)
  if (out) {
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'summary.json'), JSON.stringify({ tolerance, ...run }, null, 2) + '\n')
  }
  return run
}

/**
 * The comparison as lines for a person: the denominator first, then the most changed pictures.
 * @param {RunComparison} run @param {{ limit?: number }} [options]
 */
export function formatComparison(run, { limit = 15 } = {}) {
  const count = (kind) => run.verdicts.filter((v) => v.kind === kind).length
  const pct = (r) => `${(r * 100).toFixed(r < 0.001 ? 3 : 2)}%`
  const lines = [
    `in both        ${run.common}`,
    `compared       ${run.compared} of ${run.common}`,
    `  identical    ${count('identical')}`,
    `  changed      ${count('changed')}`,
    `not compared   resized ${count('resized')} · unreadable ${count('unreadable')}`,
    `only before    ${run.onlyBefore.length}    only after ${run.onlyAfter.length}`,
  ]
  const changed = run.verdicts.filter((v) => v.kind === 'changed')
  if (changed.length > 0) {
    lines.push('', 'Most changed (share of pixels · changed area):')
    for (const v of changed.slice(0, limit)) lines.push(`  ${pct(v.ratio).padStart(8)}  ${v.box.width}x${v.box.height} at ${v.box.x},${v.box.y}  ${v.name}`)
    if (changed.length > limit) lines.push(`  … ${changed.length - limit} more`)
  }
  for (const v of run.verdicts) {
    if (v.kind === 'resized') lines.push(`  resized     ${v.before} → ${v.after}  ${v.name}`)
    if (v.kind === 'unreadable') lines.push(`  unreadable  ${v.reason}  ${v.name}`)
  }
  for (const name of run.onlyBefore) lines.push(`  only before ${name}`)
  for (const name of run.onlyAfter) lines.push(`  only after  ${name}`)
  return lines
}
