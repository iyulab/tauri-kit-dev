import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPinDrift, formatLine, parseVersion, readWaivers } from '../src/pin-drift.js'

/** A restored graph: `packages` is [id, version, authors]; `pins` go into the props file. */
function fixture(packages, pins) {
  const dir = mkdtempSync(join(tmpdir(), 'pin-drift-'))
  const folder = join(dir, 'packages')
  const libraries = {}
  const target = {}
  for (const [id, version, authors] of packages) {
    const path = `${id.toLowerCase()}/${version}`
    mkdirSync(join(folder, path), { recursive: true })
    writeFileSync(join(folder, path, `${id.toLowerCase()}.nuspec`), `<package><metadata><authors>${authors}</authors></metadata></package>`)
    libraries[`${id}/${version}`] = { path }
    target[`${id}/${version}`] = { type: 'package' }
  }
  writeFileSync(join(dir, 'project.assets.json'), JSON.stringify({ packageFolders: { [folder]: {} }, libraries, targets: { 'net10.0': target } }))
  writeFileSync(
    join(dir, 'Directory.Packages.props'),
    `<Project><ItemGroup>${pins.map(([id, v]) => `<PackageVersion Include="${id}" Version="${v}" />`).join('')}</ItemGroup></Project>`,
  )
  const assets = join(dir, 'project.assets.json')
  return { props: join(dir, 'Directory.Packages.props'), project: 'App.csproj', restore: () => assets }
}

const NEWEST = { 'Ours.Core': '1.9.0', 'Ours.Index': '2.0.0', 'Ours.Deep': '0.30.0', 'Ours.Pre': '1.0.0-beta.9', 'Theirs.Lib': '9.0.0' }
const latest = async (id) => NEWEST[id]
const noFloors = async () => new Map()

test('versions parse with and without a prerelease', () => {
  assert.deepEqual(parseVersion('1.2.3-beta.1'), { major: 1, minor: 2, patch: 3, pre: 'beta.1', raw: '1.2.3-beta.1' })
  assert.equal(parseVersion('4').minor, 0)
})

test('only the publisher’s packages are judged; a small gap passes, a major difference fails', async () => {
  const paths = fixture(
    [['Ours.Core', '1.6.0', 'iyu, Example Co'], ['Ours.Index', '1.4.0', 'example co'], ['Theirs.Lib', '1.0.0', 'Someone']],
    [['Ours.Core', '1.6.0'], ['Ours.Index', '1.4.0'], ['Theirs.Lib', '1.0.0']],
  )
  const report = await checkPinDrift({ ...paths, publisher: 'Example Co', latest, floors: noFloors })
  assert.equal(report.failures, 1)
  assert.equal(report.pinned, 2)
  assert.deepEqual(report.lines.map(formatLine), [
    '  ok      Ours.Core 1.6.0 (latest 1.9.0, 3 minor behind)',
    '  FAIL    Ours.Index 1.4.0 (latest 2.0.0, major version differs; no waiver)',
  ])
})

test('more than the allowed minor gap fails; a live waiver passes it and an expired one does not', async () => {
  const paths = fixture([['Ours.Deep', '0.20.0', 'Example Co']], [['Ours.Deep', '0.20.0']])
  const run = (waivers) =>
    checkPinDrift({ ...paths, publisher: 'Example Co', latest, floors: noFloors, today: '2026-10-01', waivers })
  assert.equal((await run([])).failures, 1)
  const live = await run([{ package: 'Ours.Deep', until: '2026-10-15', reason: 'waiting on a fix' }])
  assert.equal(live.failures, 0)
  assert.equal(formatLine(live.lines[0]), '  waived  Ours.Deep 0.20.0 (latest 0.30.0, 10 minor behind) until 2026-10-15: waiting on a fix')
  const expired = await run([{ package: 'Ours.Deep', until: '2026-09-30', reason: 'old' }])
  assert.match(formatLine(expired.lines[0]), /waiver expired on 2026-09-30/)
})

test('a waiver that is not needed, or matches nothing, is reported as stale', async () => {
  const paths = fixture([['Ours.Core', '1.9.0', 'Example Co']], [['Ours.Core', '1.9.0']])
  const report = await checkPinDrift({
    ...paths, publisher: 'Example Co', latest, floors: noFloors, today: '2026-10-01',
    waivers: [{ package: 'Ours.Core', until: '2026-12-01', reason: 'x' }, { package: 'Gone', until: '2026-12-01', reason: 'y' }],
  })
  assert.deepEqual(report.lines.map(formatLine), [
    '  ok      Ours.Core 1.9.0 (latest 1.9.0, current)',
    '  stale   waiver for Ours.Core is no longer needed — remove it',
    '  stale   waiver for Gone matches no tracked package — remove it',
  ])
})

test('a waiver without an expiry is refused', () => {
  assert.throws(() => readWaivers([{ package: 'A', reason: 'forever' }], '2026-10-01'), /needs package, until and reason/)
  assert.throws(() => readWaivers([{ package: 'A', until: 'soon', reason: 'r' }], '2026-10-01'), /YYYY-MM-DD/)
})

test('a transitive package of the publisher is held to the same threshold, and a prerelease to prereleases', async () => {
  const paths = fixture(
    [['Ours.Core', '1.9.0', 'Example Co'], ['Ours.Deep', '0.10.0', 'Example Co'], ['Ours.Pre', '1.0.0-beta.1', 'Example Co']],
    [['Ours.Core', '1.9.0'], ['Ours.Pre', '1.0.0-beta.1']],
  )
  const seen = []
  const report = await checkPinDrift({
    ...paths, publisher: 'Example Co', floors: noFloors,
    latest: async (id, pre) => (seen.push([id, pre]), NEWEST[id]),
  })
  assert.equal(report.transitive, 1)
  assert.ok(seen.some(([id, pre]) => id === 'Ours.Pre' && pre === true))
  assert.equal(formatLine(report.lines.at(-1)), '  FAIL    Ours.Deep 0.10.0 (transitive) (latest 0.30.0, 20 minor behind; no waiver) — move the pinned package that brings it in')
})

test('a pinned package’s stale floor on another of the publisher’s packages is noted, not failed', async () => {
  const paths = fixture([['Ours.Core', '1.9.0', 'Example Co'], ['Ours.Deep', '0.30.0', 'Example Co']], [['Ours.Core', '1.9.0']])
  const report = await checkPinDrift({
    ...paths, publisher: 'Example Co', latest,
    floors: async () => new Map([['Ours.Deep', '0.12.0'], ['Theirs.Lib', '1.0.0']]),
  })
  assert.equal(report.failures, 0)
  assert.equal(formatLine(report.lines.at(-1)), '  note    Ours.Core 1.9.0 still declares Ours.Deep >= 0.12.0, 18 minor versions behind 0.30.0 — is it still kept up with?')
})

test('the project is restored before its graph is read', async () => {
  const paths = fixture([['Ours.Core', '1.8.0', 'Example Co']], [['Ours.Core', '1.8.0']])
  const restored = []
  const restore = (project) => (restored.push(project), paths.restore(project))
  await checkPinDrift({ ...paths, restore, publisher: 'Example Co', latest, floors: noFloors })
  assert.deepEqual(restored, ['App.csproj'])
})

test('the restore is given the properties the app is published with', async () => {
  const paths = fixture([['Ours.Core', '1.8.0', 'Example Co']], [['Ours.Core', '1.8.0']])
  const restored = []
  const restore = (project, properties) => (restored.push([project, properties]), paths.restore(project))
  const properties = { RuntimeIdentifier: 'win-x64' }
  await checkPinDrift({ ...paths, properties, restore, publisher: 'Example Co', latest, floors: noFloors })
  assert.deepEqual(restored, [['App.csproj', properties]])
})

test('no pins of the publisher is an error, not a pass', async () => {
  const paths = fixture([['Theirs.Lib', '1.0.0', 'Someone']], [['Theirs.Lib', '1.0.0']])
  await assert.rejects(checkPinDrift({ ...paths, publisher: 'Example Co', latest, floors: noFloors }), /no pins of Example Co packages/)
})
