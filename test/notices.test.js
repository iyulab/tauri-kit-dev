import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERMISSIVE,
  cargoPackages,
  isAccepted,
  licenseIdentifiers,
  needsReview,
  noticesTable,
  noticesText,
  npmPackages,
  nugetPackages,
  withoutText,
  writeOrCheck,
} from '../src/notices.js'

const scratch = () => mkdtempSync(join(tmpdir(), 'notices-'))

test('an old-style slash expression is two identifiers, not one unknown', () => {
  assert.deepEqual(licenseIdentifiers('MIT/Apache-2.0'), ['MIT', 'Apache-2.0'])
  assert.deepEqual(licenseIdentifiers('(MIT OR Apache-2.0) AND Unicode-3.0'), ['MIT', 'Apache-2.0', 'Unicode-3.0'])
  assert.deepEqual(licenseIdentifiers('Apache-2.0 WITH LLVM-exception'), ['Apache-2.0', 'LLVM-exception'])
})

test('one accepted alternative is enough; the accepted set is the caller’s', () => {
  assert.ok(isAccepted('MIT OR GPL-3.0-only', PERMISSIVE))
  assert.ok(!isAccepted('GPL-3.0-only', PERMISSIVE))
  assert.ok(isAccepted('GPL-3.0-only', [...PERMISSIVE, 'GPL-3.0-only']))
  const flagged = needsReview(
    [
      { name: 'a', version: '1', license: 'MIT', url: '' },
      { name: 'b', version: '1', license: '(not declared)', url: '' },
    ],
    PERMISSIVE,
  )
  assert.deepEqual(flagged.map((p) => p.name), ['b'])
})

test('the cargo closure follows normal dependencies only', () => {
  const pkg = (name, extra = {}) => ({ id: name, name, version: '1.0.0', license: 'MIT', ...extra })
  const dep = (name, kind = null) => ({ pkg: name, dep_kinds: [{ kind }] })
  const metadata = {
    packages: [pkg('app'), pkg('serde', { repository: 'https://github.com/serde-rs/serde' }), pkg('cc'), pkg('itoa', { license: null }), pkg('mockall')],
    resolve: {
      root: 'app',
      nodes: [
        { id: 'app', deps: [dep('serde'), dep('cc', 'build'), dep('mockall', 'dev')] },
        { id: 'serde', deps: [dep('itoa')] },
        { id: 'cc', deps: [] },
      ],
    },
  }
  const packages = cargoPackages({ cwd: '.', target: 'x86_64-pc-windows-msvc', metadata })
  assert.deepEqual(packages, [
    { name: 'itoa', version: '1.0.0', license: '(not declared)', url: 'https://crates.io/crates/itoa', texts: [] },
    { name: 'serde', version: '1.0.0', license: 'MIT', url: 'https://github.com/serde-rs/serde', texts: [] },
  ])
})

test('a crate carries the license texts in its folder, and the workspace’s own crates are left out', () => {
  const dir = scratch()
  const folder = (name, files) => {
    mkdirSync(join(dir, name), { recursive: true })
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, name, file), text)
    return join(dir, name, 'Cargo.toml')
  }
  const pkg = (name, manifest, extra = {}) => ({ id: name, name, version: '1.0.0', license: 'MIT OR Apache-2.0', manifest_path: manifest, ...extra })
  const dep = (name) => ({ pkg: name, dep_kinds: [{ kind: null }] })
  const metadata = {
    workspace_members: ['app', 'app-core'],
    packages: [
      pkg('app', folder('app', {})),
      pkg('app-core', folder('app-core', { LICENSE: 'own code' })),
      pkg('dual', folder('dual', { 'LICENSE-MIT': 'Copyright (c) Dual\r\n\r\nPermission …\r\n', 'LICENSE-APACHE': 'Apache License' })),
      pkg('odd', folder('odd', { 'TERMS.txt': 'Copyright (c) Odd' }), { license: null, license_file: 'TERMS.txt' }),
      pkg('bare', folder('bare', {})),
    ],
    resolve: {
      root: 'app',
      nodes: [
        { id: 'app', deps: [dep('app-core'), dep('dual')] },
        { id: 'app-core', deps: [dep('odd'), dep('bare')] },
      ],
    },
  }
  const packages = cargoPackages({ cwd: '.', target: 'x86_64-pc-windows-msvc', metadata })
  assert.deepEqual(packages.map((p) => p.name), ['bare', 'dual', 'odd'])
  assert.deepEqual(packages.find((p) => p.name === 'dual').texts, ['Apache License', 'Copyright (c) Dual\n\nPermission …'])
  assert.deepEqual(packages.find((p) => p.name === 'odd').texts, ['Copyright (c) Odd'])
  assert.deepEqual(withoutText(packages).map((p) => p.name), ['bare'])
})

test('the npm closure leaves out dev dependencies and links, and fills in from installed manifests', () => {
  const dir = scratch()
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      packages: {
        '': { name: 'app' },
        'node_modules/b': { version: '2.0.0', license: 'ISC' },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/a/node_modules/@scope/c': { version: '3.0.0', license: 'MIT' },
        'node_modules/vitest': { version: '9.0.0', dev: true },
        'node_modules/local': { link: true },
      },
    }),
  )
  mkdirSync(join(dir, 'node_modules', 'a'), { recursive: true })
  writeFileSync(
    join(dir, 'node_modules', 'a', 'package.json'),
    JSON.stringify({ license: 'BSD-3-Clause', repository: { url: 'git+https://github.com/x/a.git' } }),
  )
  writeFileSync(join(dir, 'node_modules', 'a', 'LICENSE.md'), 'Copyright (c) A\n')
  const installed = npmPackages({ lock: join(dir, 'package-lock.json'), installedAt: dir })
  assert.deepEqual(installed, [
    { name: '@scope/c', version: '3.0.0', license: 'MIT', url: 'https://www.npmjs.com/package/@scope/c', texts: [] },
    { name: 'a', version: '1.0.0', license: 'BSD-3-Clause', url: 'https://github.com/x/a', texts: ['Copyright (c) A'] },
    { name: 'b', version: '2.0.0', license: 'ISC', url: 'https://www.npmjs.com/package/b', texts: [] },
  ])
  const lockOnly = npmPackages({ lock: join(dir, 'package-lock.json') })
  assert.equal(lockOnly.find((p) => p.name === 'a').license, '(not declared)')
  assert.deepEqual(lockOnly.find((p) => p.name === 'a').texts, [])
})

test('NuGet packages count only when they put assets into the build', () => {
  const dir = scratch()
  const folder = join(dir, 'packages')
  const nuspec = (id, version, body) => {
    mkdirSync(join(folder, id, version), { recursive: true })
    writeFileSync(join(folder, id, version, `${id}.nuspec`), `<package><metadata>${body}</metadata></package>`)
  }
  nuspec('lib.a', '1.0.0', '<license type="expression">MIT</license><repository type="git" url="https://github.com/x/a.git" />')
  nuspec('lib.b', '2.0.0', '<license type="file">LICENSE.txt</license>')
  writeFileSync(join(folder, 'lib.b', '2.0.0', 'LICENSE.txt'), 'MIT License\n\nCopyright …')
  writeFileSync(join(folder, 'lib.b', '2.0.0', 'NOTICE'), 'not the file the nuspec names')
  writeFileSync(join(folder, 'lib.a', '1.0.0', 'LICENSE.txt'), 'Copyright (c) A')
  writeFileSync(join(folder, 'lib.a', '1.0.0', 'THIRD-PARTY-NOTICES.txt'), 'notices of what it bundles')
  nuspec('lib.c', '3.0.0', '<licenseUrl>https://example.com/license</licenseUrl>')
  writeFileSync(
    join(dir, 'project.assets.json'),
    JSON.stringify({
      packageFolders: { [folder + '/']: {} },
      targets: {
        'net10.0': {
          'Lib.A/1.0.0': { type: 'package', runtime: { 'lib/net10.0/Lib.A.dll': {} } },
          'Lib.B/2.0.0': { type: 'package', native: { 'runtimes/win-x64/native/b.dll': {} } },
          'Lib.C/3.0.0': { type: 'package', runtimeTargets: { 'runtimes/win/lib/c.dll': {} } },
          'Meta/1.0.0': { type: 'package', runtime: { 'lib/net10.0/_._': {} } },
          'Project/1.0.0': { type: 'project' },
        },
        'net10.0/win-x64': { 'Lib.A/1.0.0': { type: 'package', runtime: { 'lib/net10.0/Lib.A.dll': {} } } },
      },
    }),
  )
  assert.deepEqual(nugetPackages({ assets: join(dir, 'project.assets.json') }), [
    { name: 'Lib.A', version: '1.0.0', license: 'MIT', url: 'https://github.com/x/a', texts: ['Copyright (c) A'] },
    { name: 'Lib.B', version: '2.0.0', license: 'MIT', url: 'https://www.nuget.org/packages/Lib.B', texts: ['MIT License\n\nCopyright …'] },
    { name: 'Lib.C', version: '3.0.0', license: 'see https://example.com/license', url: 'https://www.nuget.org/packages/Lib.C', texts: [] },
  ])
  assert.throws(() => nugetPackages({ assets: join(dir, 'missing.json') }), /dotnet restore/)
})

test('a table has one row per package', () => {
  assert.equal(
    noticesTable([{ name: 'a', version: '1', license: 'MIT', url: 'https://x' }]),
    '| Component | Version | License | Upstream |\n| --- | --- | --- | --- |\n| `a` | 1 | MIT | https://x |',
  )
})

test('a notices document keeps every text whole and prints a shared one once', () => {
  const mit = (holder) => `Copyright (c) ${holder}\n\nPermission is hereby granted …`
  const doc = noticesText([
    { name: 'a', version: '1', license: 'MIT', url: 'https://a', texts: [mit('A')] },
    { name: 'b', version: '2', license: 'MIT', url: 'https://b', texts: [mit('B')] },
    { name: 'c', version: '3', license: 'MIT', url: 'https://c', texts: [mit('A')] },
    { name: 'd', version: '4', license: 'ISC', url: 'https://d', texts: [] },
  ])
  assert.match(doc, /^Third-party notices\n=+\n\nThis program includes the following 4 third-party packages\./)
  assert.equal(doc.split(mit('A')).length - 1, 1)
  assert.equal(doc.split(mit('B')).length - 1, 1)
  assert.match(doc, /c 3\nLicense: MIT\nUpstream: https:\/\/c\n\nSame license text as a 1\./)
  assert.match(doc, /d 4\nLicense: ISC\nUpstream: https:\/\/d\n/)
  assert.match(noticesText([], { title: 'Notices' }), /^Notices\n=======\n/)
})

test('writeOrCheck writes, then reports whether the file still matches', () => {
  const file = join(scratch(), 'NOTICES.md')
  assert.equal(writeOrCheck(file, 'one', { check: true }), false)
  assert.equal(writeOrCheck(file, 'one'), true)
  assert.equal(readFileSync(file, 'utf8'), 'one')
  assert.equal(writeOrCheck(file, 'one', { check: true }), true)
  assert.equal(writeOrCheck(file, 'two', { check: true }), false)
  assert.equal(readFileSync(file, 'utf8'), 'one')
})
