import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cargoDeclared, checkRegistryDrift, declaredVersion, npmDeclared } from '../src/registry-drift.js'

const OURS = /^(git\+)?https:\/\/github\.com\/ours\//i

/** An app's two manifests, and registries that know what each dependency is and where it lives. */
function app() {
  const dir = mkdtempSync(join(tmpdir(), 'registry-drift-'))
  const npm = join(dir, 'package.json')
  writeFileSync(
    npm,
    JSON.stringify({
      dependencies: { '@ours/kit': '^0.3.0', '@ours/ui': '2.29.0', lit: '^3.0.0', local: 'file:../local' },
      devDependencies: { '@ours/dev': '~0.9.0' },
    }),
  )
  const cargo = join(dir, 'Cargo.toml')
  writeFileSync(
    cargo,
    [
      '[package]',
      'name = "shell"',
      'version = "0.2.0"',
      '',
      '[dependencies]',
      'ours-fs = "0.18.0"',
      'ours-sidecar = { version = "0.19.0", features = ["loopback"] }',
      'renamed = { package = "ours-watch", version = "0.12.0" }',
      'serde = "1"',
      'helper = { path = "../helper" }',
      '',
      '[target.\'cfg(windows)\'.dependencies]',
      'ours-credentials = "0.19.0"',
      '',
      '[profile.release]',
      'lto = true',
    ].join('\n'),
  )
  const npmRegistry = {
    '@ours/kit': ['0.9.0', 'git+https://github.com/ours/kit.git'],
    '@ours/ui': ['2.29.0', 'https://github.com/ours/ui'],
    '@ours/dev': ['0.9.4', 'https://github.com/ours/dev'],
    lit: ['3.3.0', 'https://github.com/lit/lit'],
  }
  const crates = {
    'ours-fs': ['0.19.0', 'https://github.com/ours/kit'],
    'ours-sidecar': ['0.19.0', 'https://github.com/ours/kit'],
    'ours-watch': ['1.0.0', 'https://github.com/ours/kit'],
    'ours-credentials': ['0.19.0', 'https://github.com/ours/kit'],
    serde: ['1.0.228', 'https://github.com/serde-rs/serde'],
  }
  const lookup = (table) => async (name) => (table[name] ? { name, version: table[name][0], latest: table[name][0], repository: table[name][1] } : null)
  return { npm, cargo, npmLookup: lookup(npmRegistry), crateLookup: lookup(crates) }
}

test('a declared range is judged by its lower bound; a path, file or git dependency by none', () => {
  assert.equal(declaredVersion('^1.2.3'), '1.2.3')
  assert.equal(declaredVersion('~0.9'), '0.9.0')
  assert.equal(declaredVersion('1'), '1.0.0')
  assert.equal(declaredVersion('^2.0.0-beta.1 || ^3.0.0'), '2.0.0-beta.1')
  assert.equal(declaredVersion('file:../local'), null)
  assert.equal(declaredVersion('workspace:*'), null)
})

test('reads every dependencies table a Cargo.toml has, under the crate a renamed one names', () => {
  const { cargo, npm } = app()
  assert.deepEqual([...cargoDeclared(cargo)], [
    ['ours-fs', '0.18.0'],
    ['ours-sidecar', '0.19.0'],
    ['ours-watch', '0.12.0'],
    ['serde', '1'],
    ['ours-credentials', '0.19.0'],
  ])
  assert.deepEqual([...npmDeclared(npm).keys()].sort(), ['@ours/dev', '@ours/kit', '@ours/ui', 'lit', 'local'])
})

test('judges only the packages whose repository is the publisher’s — a gap within the threshold passes, a major difference fails', async () => {
  const report = await checkRegistryDrift({ ...app(), repository: OURS, maxMinorGap: 5 })
  const text = report.lines.map((l) => `${l.level} ${l.text}`)
  assert.equal(report.checked, 7, 'four crates and three npm packages of ours; lit and serde are not judged')
  assert.ok(text.includes('FAIL ours-watch 0.12.0 (crate) (latest 1.0.0, major version differs; no waiver)'))
  assert.ok(text.includes('FAIL @ours/kit 0.3.0 (npm) (latest 0.9.0, 6 minor behind; no waiver)'))
  assert.ok(text.includes('ok ours-fs 0.18.0 (crate) (latest 0.19.0, 1 minor behind)'))
  assert.ok(text.includes('ok @ours/ui 2.29.0 (npm) (latest 2.29.0, current)'))
  assert.equal(report.failures, 2)
  assert.ok(!text.some((t) => /lit|serde/.test(t)))
})

test('a waiver with an unexpired date covers a drift, an expired one does not, and one that matches nothing is said', async () => {
  const report = await checkRegistryDrift({
    ...app(),
    repository: OURS,
    today: '2026-10-17',
    waivers: [
      { package: 'ours-watch', until: '2026-11-01', reason: '1.0 moves the watcher API; after the release' },
      { package: '@ours/kit', until: '2026-10-01', reason: 'old' },
      { package: '@ours/gone', until: '2026-12-01', reason: 'removed' },
    ],
  })
  const text = report.lines.map((l) => `${l.level} ${l.text}`)
  assert.ok(text.some((t) => t.startsWith('waived ours-watch 0.12.0')))
  assert.ok(text.some((t) => t.startsWith('FAIL @ours/kit') && t.includes('waiver expired on 2026-10-01')))
  assert.ok(text.includes('stale waiver for @ours/gone matches no tracked package — remove it'))
  assert.equal(report.failures, 1)
})

test('a pattern that matches no declared package is an error, not a pass', async () => {
  await assert.rejects(checkRegistryDrift({ ...app(), repository: /github\.com\/nobody\// }), /no declared package's repository matches/)
  await assert.rejects(checkRegistryDrift({ repository: OURS }), /nothing to check/)
})
