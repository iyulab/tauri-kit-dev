// The PNG reader is written against node:zlib rather than a dependency, so it is proved here on every
// row filter the format has: each image is encoded with one filter and must decode to the exact bytes
// it started from. Those round trips share this module's encoder, so a mistake made the same way
// twice would pass them — one fixture from an independent encoder, read by an independent decoder,
// closes that. The comparison is proved on what makes it trustworthy: it counts what it could
// compare, and refuses pairs it cannot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import {
  compareFolders,
  comparePair,
  decodePng,
  diffImages,
  encodePng,
  formatComparison,
  pairNames,
  summarizeRun,
  UnsupportedPngError,
} from '../src/visual.js'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'visual')

/** A deterministic, non-trivial picture: gradients plus a hard edge, so every filter has work to do. */
function picture(width, height, seed = 0) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      rgba[i] = (x * 37 + seed) & 0xff
      rgba[i + 1] = (y * 53 + seed * 3) & 0xff
      rgba[i + 2] = x > width / 2 ? 250 : (x * y) & 0xff
      rgba[i + 3] = y % 3 === 0 ? 255 : 128
    }
  }
  return { width, height, rgba }
}

for (const filter of [0, 1, 2, 3, 4]) {
  test(`decodePng reads a PNG written with row filter ${filter} back to the same bytes`, () => {
    const img = picture(23, 11, filter)
    const back = decodePng(encodePng(img, filter))
    assert.equal(back.width, 23)
    assert.equal(back.height, 11)
    assert.deepEqual(back.rgba, img.rgba)
  })
}

test('decodePng agrees with an independent decoder on a PNG from an independent encoder', () => {
  // Written by Chromium's PNG encoder (a page capture — the encoder behind a WebView2 screenshot;
  // its rows use the Up and Paeth filters). The expected pixels were read with the Windows GDI+
  // decoder, not with this code.
  const img = decodePng(readFileSync(join(FIXTURES, 'chromium-capture.png')))
  assert.equal(img.width, 72)
  assert.equal(img.height, 51)
  const gdiPlus = [
    [0, 0, [20, 53, 87, 255]], [71, 0, [5, 255, 137, 255]], [10, 8, [66, 62, 204, 255]],
    [20, 14, [190, 37, 111, 255]], [35, 25, [104, 79, 207, 255]], [45, 30, [234, 223, 227, 255]],
    [50, 40, [189, 240, 234, 255]], [60, 45, [101, 241, 156, 255]], [71, 50, [5, 255, 137, 255]],
    [5, 49, [48, 73, 99, 255]], [30, 3, [185, 171, 157, 255]], [66, 20, [48, 248, 145, 255]],
  ]
  for (const [x, y, expected] of gdiPlus) {
    const i = (y * img.width + x) * 4
    assert.deepEqual([...img.rgba.subarray(i, i + 4)], expected, `pixel (${x},${y})`)
  }
  // Every pixel, not a sample: SHA-256 of the RGBA bytes GDI+ read (row-major, R G B A).
  assert.equal(createHash('sha256').update(img.rgba).digest('hex'), '6e8ef6539df19ff1ade2b1ab43a92a14aefd43bf89da1626e3a6626e29dd046b')
})

test('decodePng widens an RGB PNG to opaque RGBA', () => {
  // A hand-built 2x1 RGB image (colour type 2): red, then green.
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0])
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
  assert.deepEqual([...decodePng(png).rgba], [255, 0, 0, 255, 0, 255, 0, 255])
})

test('decodePng refuses what it does not read, by name', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), UnsupportedPngError)
  const sixteenBit = Buffer.from(encodePng(picture(4, 4)))
  sixteenBit[8 + 8 + 8] = 16 // the IHDR bit depth byte; this reader does not check the CRC
  assert.throws(() => decodePng(sixteenBit), /bit depth 16/)
})

test('diffImages: identical pictures change nothing', () => {
  const d = diffImages(picture(10, 10), picture(10, 10))
  assert.equal(d.changedPixels, 0)
  assert.equal(d.box, null)
})

test('diffImages: jitter within the tolerance is not a change; past it, it is — with its box', () => {
  const a = picture(10, 10)
  const b = { ...a, rgba: a.rgba.slice() }
  for (let i = 0; i < b.rgba.length; i += 4) b.rgba[i] = Math.min(255, b.rgba[i] + 3)
  assert.equal(diffImages(a, b).changedPixels, 0)

  // Two pixels moved well past it: (2,1) and (6,4).
  for (const [x, y] of [[2, 1], [6, 4]]) b.rgba[(y * 10 + x) * 4 + 2] ^= 0x80
  const d = diffImages(a, b)
  assert.equal(d.changedPixels, 2)
  assert.deepEqual(d.box, { x: 2, y: 1, width: 5, height: 4 })
  assert.equal(d.ratio, 0.02)
  // The overlay marks exactly the changed pixels.
  const magenta = (x, y) => {
    const i = (y * 10 + x) * 4
    return d.overlay.rgba[i] === 255 && d.overlay.rgba[i + 1] === 0
  }
  assert.ok(magenta(2, 1) && magenta(6, 4) && !magenta(0, 0))
})

test('diffImages: different sizes are not compared', () => {
  assert.equal(diffImages(picture(10, 10), picture(10, 11)), null)
})

test('comparePair names each outcome, and summarizeRun keeps the denominator', () => {
  const same = encodePng(picture(8, 8))
  const moved = encodePng(picture(8, 8, 90))
  const taller = encodePng(picture(8, 9))

  const verdicts = [
    comparePair('a.png', same, same).verdict,
    comparePair('b.png', same, moved).verdict,
    comparePair('c.png', same, taller).verdict,
    comparePair('d.png', same, Buffer.from('broken')).verdict,
  ]
  assert.deepEqual(verdicts.map((v) => v.kind), ['identical', 'changed', 'resized', 'unreadable'])

  const pairs = pairNames(['a.png', 'b.png', 'c.png', 'd.png', 'gone.png'], ['a.png', 'b.png', 'c.png', 'd.png', 'new.png'])
  const run = summarizeRun(pairs, verdicts)
  assert.equal(run.common, 4)
  assert.equal(run.compared, 2, 'resized and unreadable pairs are not counted as compared')
  assert.deepEqual(run.onlyBefore, ['gone.png'])
  assert.deepEqual(run.onlyAfter, ['new.png'])
  assert.equal(run.verdicts[0].name, 'b.png', 'the most changed picture comes first')
})

test('compareFolders compares by name, writes a diff picture per change and a summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'visual-'))
  const before = join(root, 'before')
  const after = join(root, 'after')
  const out = join(root, 'out')
  mkdirSync(before)
  mkdirSync(after)
  writeFileSync(join(before, 'home.png'), encodePng(picture(6, 6)))
  writeFileSync(join(after, 'home.png'), encodePng(picture(6, 6)))
  writeFileSync(join(before, 'list.png'), encodePng(picture(6, 6)))
  writeFileSync(join(after, 'list.png'), encodePng(picture(6, 6, 40)))
  writeFileSync(join(after, 'notes.txt'), 'not a picture')

  const run = compareFolders(before, after, { out })
  assert.equal(run.common, 2)
  assert.equal(run.compared, 2)
  assert.deepEqual(run.verdicts.map((v) => [v.name, v.kind]), [['list.png', 'changed'], ['home.png', 'identical']])
  assert.deepEqual(readdirSync(out).sort(), ['list.diff.png', 'summary.json'])
  assert.equal(decodePng(readFileSync(join(out, 'list.diff.png'))).width, 6)
  assert.equal(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).compared, 2)

  // Without `out`, nothing is written.
  const entries = readdirSync(root).sort()
  compareFolders(before, after)
  assert.deepEqual(readdirSync(root).sort(), entries)
  assert.equal(existsSync(join(before, 'summary.json')) || existsSync(join(after, 'summary.json')), false)
  assert.throws(() => compareFolders(before, after, { tolerance: 300 }), /0–255/)
})

test('formatComparison leads with the denominator and names what was not compared', () => {
  const lines = formatComparison({
    common: 3,
    compared: 1,
    onlyBefore: ['gone.png'],
    onlyAfter: [],
    verdicts: [
      { name: 'b.png', kind: 'changed', ratio: 0.25, changedPixels: 9, box: { x: 1, y: 2, width: 3, height: 3 } },
      { name: 'c.png', kind: 'resized', before: '8x8', after: '8x9' },
      { name: 'd.png', kind: 'unreadable', reason: 'PNG not supported: interlaced' },
    ],
  })
  assert.equal(lines[0], 'in both        3')
  assert.equal(lines[1], 'compared       1 of 3')
  assert.ok(lines.includes('    25.00%  3x3 at 1,2  b.png'))
  assert.ok(lines.some((l) => l.includes('8x8 → 8x9') && l.includes('c.png')))
  assert.ok(lines.some((l) => l.includes('interlaced') && l.includes('d.png')))
  assert.ok(lines.includes('  only before gone.png'))
})
