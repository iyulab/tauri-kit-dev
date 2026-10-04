import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERMISSIVE,
  applyPinned,
  fetchPinned,
  cargoPackages,
  isAccepted,
  licenseIdentifiers,
  needsReview,
  noticesTable,
  noticesText,
  shippedNotices,
  npmPackages,
  nugetPackages,
  suggestPins,
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
      pkg('bare', folder('bare', { '.cargo_vcs_info.json': '{"git":{"sha1":"abc123"},"path_in_vcs":"crates/bare"}' })),
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
  // The commit and folder `cargo publish` recorded; a crate without the record has no `vcs`.
  assert.deepEqual(packages.find((p) => p.name === 'bare').vcs, { commit: 'abc123', path: 'crates/bare' })
  assert.equal(packages.find((p) => p.name === 'dual').vcs, undefined)
})

test('a pin is suggested from the source at the version that shipped, never a branch', async () => {
  const exists = new Set([
    // At the commit the crate was published from, in its own folder.
    'https://raw.githubusercontent.com/o/rs/abc123/crates/bare/LICENSE-MIT',
    // A root license at a release tag, for a package that names no commit.
    'https://raw.githubusercontent.com/o/js/v2.0.0/LICENSE',
    // A scoped npm package tagged with its name.
    'https://raw.githubusercontent.com/o/mono/%40s/c%403.0.0/packages/c/LICENSE',
    // Only on the default branch: not what the version shipped with.
    'https://raw.githubusercontent.com/o/gone/main/LICENSE',
  ])
  const asked = []
  const fetch = async (url, init) => {
    asked.push(url)
    assert.equal(init.method, 'HEAD')
    return { ok: exists.has(url) }
  }
  const packages = [
    { name: 'bare', version: '1.0.0', license: 'MIT OR Apache-2.0', url: 'https://github.com/o/rs', texts: [], vcs: { commit: 'abc123', path: 'crates/bare' } },
    { name: 'js', version: '2.0.0', license: 'ISC', url: 'git+https://github.com/o/js.git', texts: [] },
    { name: '@s/c', version: '3.0.0', license: 'MIT', url: 'https://github.com/o/mono', texts: [], vcs: { path: 'packages/c' } },
    { name: 'gone', version: '1.0.0', license: 'MIT', url: 'https://github.com/o/gone', texts: [] },
    { name: 'elsewhere', version: '1.0.0', license: 'MIT', url: 'https://gitlab.com/o/elsewhere', texts: [] },
    { name: 'carries', version: '1.0.0', license: 'MIT', url: 'https://github.com/o/carries', texts: ['Copyright'] },
  ]
  const { pins, unresolved } = await suggestPins(packages, { fetch })
  assert.deepEqual(pins, {
    'bare@1.0.0': { source: 'https://raw.githubusercontent.com/o/rs/abc123/crates/bare/LICENSE-MIT' },
    'js@2.0.0': { source: 'https://raw.githubusercontent.com/o/js/v2.0.0/LICENSE' },
    '@s/c@3.0.0': { source: 'https://raw.githubusercontent.com/o/mono/%40s/c%403.0.0/packages/c/LICENSE' },
  })
  assert.deepEqual(unresolved, ['gone@1.0.0', 'elsewhere@1.0.0'])
  // With a commit, no tag is tried; a branch never is; a package carrying its text is not looked up.
  assert.ok(!asked.some((u) => u.includes('/o/rs/v1.0.0/')))
  assert.ok(!asked.some((u) => /\/(main|master)\//.test(u)))
  assert.ok(!asked.some((u) => u.includes('/o/carries/') || u.includes('gitlab')))
})

test('a package already pinned is never suggested again, even when its pinned text fails', async () => {
  const asked = []
  const fetch = async (url) => {
    asked.push(url)
    return { ok: true }
  }
  // Without a text because its pinned file no longer matches: the pin's failure, not a new pin.
  const packages = [{ name: 'p', version: '1.0.0', license: 'MIT', url: 'https://github.com/o/p', texts: [] }]
  const { pins, unresolved } = await suggestPins(packages, { fetch, pinned: ['p@1.0.0'] })
  assert.deepEqual(pins, {})
  assert.deepEqual(unresolved, [])
  assert.deepEqual(asked, [])
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
  nuspec('lib.a', '1.0.0', '<license type="expression">MIT</license><repository type="git" url="https://github.com/x/a.git" commit="def456" />')
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
  assert.deepEqual(nugetPackages({ project: 'Helper.csproj', restore: () => join(dir, 'project.assets.json') }), [
    { name: 'Lib.A', version: '1.0.0', license: 'MIT', url: 'https://github.com/x/a', texts: ['Copyright (c) A'], bundledNotices: ['notices of what it bundles'], vcs: { commit: 'def456' } },
    { name: 'Lib.B', version: '2.0.0', license: 'MIT', url: 'https://www.nuget.org/packages/Lib.B', texts: ['MIT License\n\nCopyright …'] },
    { name: 'Lib.C', version: '3.0.0', license: 'see https://example.com/license', url: 'https://www.nuget.org/packages/Lib.C', texts: [] },
  ])
  assert.throws(() => nugetPackages({ project: 'Helper.csproj', restore: () => join(dir, 'missing.json') }), /restoring Helper\.csproj left no/)
})

test('the nuget source reads the graph the restore of its project just wrote', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'project.assets.json'), JSON.stringify({ packageFolders: { [dir + '/']: {} }, targets: { 'net10.0': {} } }))
  const restored = []
  shippedNotices({ nuget: { project: 'Helper.csproj', restore: (project) => (restored.push(project), join(dir, 'project.assets.json')) } })
  assert.deepEqual(restored, ['Helper.csproj'])
})

test('the nuget source restores with the properties the helper is published with', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'project.assets.json'), JSON.stringify({ packageFolders: { [dir + '/']: {} }, targets: { 'net10.0': {} } }))
  const restored = []
  const restore = (project, properties) => (restored.push([project, properties]), join(dir, 'project.assets.json'))
  const properties = { RuntimeIdentifier: 'win-x64', SelfContained: true }
  shippedNotices({ nuget: { project: 'Helper.csproj', properties, restore } })
  assert.deepEqual(restored, [['Helper.csproj', properties]])
  // Without any, the restore is asked with none — not with properties of its own choosing.
  restored.length = 0
  shippedNotices({ nuget: { project: 'Helper.csproj', restore } })
  assert.deepEqual(restored, [['Helper.csproj', {}]])
})

test('a self-contained helper carries the runtime packs of the frameworks it references', () => {
  const dir = scratch()
  const folder = join(dir, 'packages')
  const pack = (id, files) => {
    mkdirSync(join(folder, id, '10.0.5'), { recursive: true })
    writeFileSync(join(folder, id, '10.0.5', `${id}.nuspec`), '<package><metadata><license type="expression">MIT</license></metadata></package>')
    for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, id, '10.0.5', name), text)
  }
  pack('microsoft.netcore.app.runtime.nativeaot.win-x64', { 'LICENSE.TXT': 'runtime license', 'THIRD-PARTY-NOTICES.TXT': 'runtime notices' })
  pack('microsoft.aspnetcore.app.runtime.win-x64', { 'LICENSE.txt': 'web license', 'ThirdPartyNotices.txt': 'web notices' })
  pack('microsoft.windowsdesktop.app.runtime.win-x64', { LICENSE: 'desktop license' })
  pack('runtime.win-x64.microsoft.dotnet.ilcompiler', { 'THIRD-PARTY-NOTICES.TXT': 'compiler notices' })
  const range = '[10.0.5, 10.0.5]'
  writeFileSync(
    join(dir, 'project.assets.json'),
    JSON.stringify({
      packageFolders: { [folder + '/']: {} },
      targets: { 'net10.0': {}, 'net10.0/win-x64': {} },
      project: {
        frameworks: {
          'net10.0': {
            frameworkReferences: { 'Microsoft.AspNetCore.App': {}, 'Microsoft.NETCore.App': {} },
            downloadDependencies: [
              { name: 'Microsoft.AspNetCore.App.Runtime.win-x64', version: range },
              { name: 'Microsoft.NETCore.App.Runtime.NativeAOT.win-x64', version: range },
              { name: 'Microsoft.WindowsDesktop.App.Runtime.win-x64', version: range },
              { name: 'runtime.win-x64.Microsoft.DotNet.ILCompiler', version: range },
            ],
          },
        },
      },
    }),
  )
  assert.deepEqual(nugetPackages({ project: 'Helper.csproj', restore: () => join(dir, 'project.assets.json') }), [
    { name: 'Microsoft.AspNetCore.App.Runtime.win-x64', version: '10.0.5', license: 'MIT', url: 'https://www.nuget.org/packages/Microsoft.AspNetCore.App.Runtime.win-x64', texts: ['web license'], bundledNotices: ['web notices'] },
    { name: 'Microsoft.NETCore.App.Runtime.NativeAOT.win-x64', version: '10.0.5', license: 'MIT', url: 'https://www.nuget.org/packages/Microsoft.NETCore.App.Runtime.NativeAOT.win-x64', texts: ['runtime license'], bundledNotices: ['runtime notices'] },
  ])
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

test('pinned texts fill in packages without one, only when the committed file is the pinned text', async () => {
  const dir = scratch()
  const texts = join(dir, 'texts')
  const pinsFile = join(dir, 'pins.json')
  const served = {
    'https://src/a/v1/LICENSE': 'Copyright (c) A\r\n\r\nPermission …\r\n',
    'https://src/@s/b/v2/LICENSE': 'Copyright (c) B',
  }
  const fetch = async (url) => (url in served ? new Response(served[url]) : new Response('gone', { status: 404 }))
  writeFileSync(
    pinsFile,
    JSON.stringify({
      'a@1.0.0': { source: 'https://src/a/v1/LICENSE' },
      '@s/b@2.0.0': { source: 'https://src/@s/b/v2/LICENSE' },
      'gone@0.1.0': { source: 'https://src/gone/LICENSE' },
    }),
  )
  await assert.rejects(fetchPinned({ pins: pinsFile, dir: texts, fetch }), /gone@0\.1\.0: https:\/\/src\/gone\/LICENSE answered 404/)
  const pins = JSON.parse(readFileSync(pinsFile, 'utf8'))
  assert.match(pins['a@1.0.0'].sha256, /^[0-9a-f]{64}$/, 'texts fetched before the failure keep their digests')
  delete pins['gone@0.1.0']
  delete pins['@s/b@2.0.0'].sha256
  writeFileSync(pinsFile, JSON.stringify(pins))
  assert.deepEqual(await fetchPinned({ pins: pinsFile, dir: texts, fetch }), { fetched: ['https://src/@s/b/v2/LICENSE'], pinned: ['https://src/@s/b/v2/LICENSE'] })
  const recorded = JSON.parse(readFileSync(pinsFile, 'utf8'))
  assert.match(recorded['@s/b@2.0.0'].sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(await fetchPinned({ pins: pinsFile, dir: texts, fetch }), { fetched: [], pinned: [] })

  const pkg = (name, version, texts = []) => ({ name, version, license: 'MIT', url: `https://${name}`, texts })
  const result = applyPinned([pkg('a', '1.0.0'), pkg('@s/b', '2.0.0', ['own text']), pkg('c', '3.0.0')], { pins: pinsFile, dir: texts })
  assert.deepEqual(result.packages[0], { ...pkg('a', '1.0.0'), texts: ['Copyright (c) A\n\nPermission …'], textSource: 'https://src/a/v1/LICENSE' })
  assert.deepEqual(result.packages[1].texts, ['own text'])
  assert.deepEqual(withoutText(result.packages).map((p) => p.name), ['c'])
  assert.deepEqual(result.unused, ['@s/b@2.0.0'])
  assert.deepEqual(result.problems, [])
  assert.match(noticesText(result.packages), /a 1\.0\.0\nLicense: MIT\nUpstream: https:\/\/a\nLicense text from: https:\/\/src\/a\/v1\/LICENSE\n\nCopyright \(c\) A/)

  // a moved version no longer matches its pin
  assert.deepEqual(applyPinned([pkg('a', '1.0.1')], { pins: pinsFile, dir: texts }).unused, ['a@1.0.0', '@s/b@2.0.0'])

  // a checkout that converts line endings still matches
  const converted = readdirSync(texts).find((f) => f.startsWith('a@'))
  writeFileSync(join(texts, converted), readFileSync(join(texts, converted), 'utf8').replace(/\r?\n/g, '\r\n'))
  assert.deepEqual(applyPinned([pkg('a', '1.0.0')], { pins: pinsFile, dir: texts }).problems, [])
  writeFileSync(join(texts, converted), readFileSync(join(texts, converted), 'utf8').replace(/\r\n/g, '\n'))
  assert.deepEqual(applyPinned([pkg('a', '1.0.0')], { pins: pinsFile, dir: texts }).problems, [])

  // a file edited by hand is not the pinned text
  const edited = readdirSync(texts).find((f) => f.startsWith('a@'))
  writeFileSync(join(texts, edited), 'something else')
  const tampered = applyPinned([pkg('a', '1.0.0')], { pins: pinsFile, dir: texts })
  assert.deepEqual(withoutText(tampered.packages).map((p) => p.name), ['a'])
  assert.match(tampered.problems[0].problem, /SHA-256 differs/)
  assert.deepEqual(await fetchPinned({ pins: pinsFile, dir: texts, fetch }), { fetched: ['https://src/a/v1/LICENSE'], pinned: [] })

  // the source changing under a pin is an error, not a silent update
  served['https://src/a/v1/LICENSE'] = 'Copyright (c) Someone else'
  writeFileSync(join(texts, edited), 'something else')
  await assert.rejects(fetchPinned({ pins: pinsFile, dir: texts, fetch }), /a@1\.0\.0: .* is not the pinned text/)
})

test('a pin can list several files, all of which the package then carries', async () => {
  const dir = scratch()
  const served = { 'https://src/x/LICENSE': 'Apache License 2.0', 'https://src/x/NOTICE': 'X\nCopyright X' }
  const fetch = async (url) => new Response(served[url])
  const pins = { 'x@1.0.0': [{ source: 'https://src/x/LICENSE' }, { source: 'https://src/x/NOTICE' }] }
  assert.deepEqual((await fetchPinned({ pins, dir, fetch })).pinned, ['https://src/x/LICENSE', 'https://src/x/NOTICE'])
  assert.deepEqual(readdirSync(dir).sort(), ['x@1.0.0.1.txt', 'x@1.0.0.2.txt'])
  const pkg = { name: 'x', version: '1.0.0', license: 'Apache-2.0', url: 'https://x', texts: [] }
  const { packages, problems } = applyPinned([pkg], { pins, dir })
  assert.deepEqual(problems, [])
  assert.deepEqual(packages[0].texts, ['Apache License 2.0', 'X\nCopyright X'])
  assert.equal(packages[0].textSource, 'https://src/x/LICENSE, https://src/x/NOTICE')
  writeFileSync(join(dir, 'x@1.0.0.2.txt'), 'changed')
  assert.deepEqual(withoutText(applyPinned([pkg], { pins, dir }).packages).map((p) => p.name), ['x'], 'one bad file leaves the package without text')
})

test('a package carrying only the notices of what it bundles still needs its own license text', async () => {
  const dir = scratch()
  const folder = join(dir, 'packages', 'lib.d', '1.0.0')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'lib.d.nuspec'), '<package><metadata><license type="expression">MIT</license></metadata></package>')
  writeFileSync(join(folder, 'THIRD-PARTY-NOTICES.TXT'), 'notices of what D bundles')
  writeFileSync(
    join(dir, 'project.assets.json'),
    JSON.stringify({
      packageFolders: { [join(dir, 'packages') + '/']: {} },
      targets: { 'net10.0': { 'Lib.D/1.0.0': { type: 'package', runtime: { 'lib/net10.0/Lib.D.dll': {} } } } },
    }),
  )
  const [shipped] = nugetPackages({ project: 'Helper.csproj', restore: () => join(dir, 'project.assets.json') })
  assert.deepEqual(shipped.texts, [])
  assert.deepEqual(shipped.bundledNotices, ['notices of what D bundles'])
  assert.deepEqual(withoutText([shipped]).map((p) => p.name), ['Lib.D'])

  const texts = join(dir, 'texts')
  const pins = { 'Lib.D@1.0.0': { source: 'https://src/d/LICENSE' } }
  await fetchPinned({ pins, dir: texts, fetch: async () => new Response('MIT License\n\nCopyright (c) D') })
  const { packages, unused } = applyPinned([shipped], { pins, dir: texts })
  assert.deepEqual(unused, [])
  assert.deepEqual(packages[0].texts, ['MIT License\n\nCopyright (c) D'])
  assert.deepEqual(packages[0].bundledNotices, ['notices of what D bundles'])
  assert.match(noticesText(packages), /Copyright \(c\) D\n\nnotices of what D bundles\n/, 'the license comes before the bundled notices')
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

test('a checkout with CRLF line endings is not stale for that alone', () => {
  const file = join(scratch(), 'NOTICES.txt')
  writeFileSync(file, 'one\r\ntwo\r\n')
  assert.equal(writeOrCheck(file, 'one\ntwo\n', { check: true }), true)
  assert.equal(writeOrCheck(file, 'one\nthree\n', { check: true }), false)
})

test('the notices command writes an app’s notices from its config, and fails on what is wrong with them', async () => {
  const { spawnSync } = await import('node:child_process')
  const { createHash } = await import('node:crypto')
  const dir = scratch()
  const app = join(dir, 'app')
  mkdirSync(join(app, 'node_modules', 'a'), { recursive: true })
  writeFileSync(
    join(app, 'package-lock.json'),
    JSON.stringify({ packages: { '': { name: 'app' }, 'node_modules/a': { version: '1.0.0', license: 'MIT' }, 'node_modules/b': { version: '2.0.0', license: 'ISC' } } }),
  )
  writeFileSync(join(app, 'node_modules', 'a', 'LICENSE'), 'Copyright (c) A\n')
  mkdirSync(join(app, 'notices', 'texts'), { recursive: true })
  writeFileSync(join(app, 'notices', 'texts', 'b@2.0.0.txt'), 'Copyright (c) B')
  const sha256 = createHash('sha256').update('Copyright (c) B').digest('hex')
  const pins = (more = {}) =>
    writeFileSync(join(app, 'notices', 'pins.json'), JSON.stringify({ 'b@2.0.0': { source: 'https://src/b/LICENSE', sha256 }, ...more }))
  pins()
  // Paths are the config's own, relative to its folder: the command runs from anywhere.
  writeFileSync(
    join(app, 'notices.config.mjs'),
    `export default { out: 'out/NOTICES.txt', title: 'App — notices', npm: { lock: 'package-lock.json', installedAt: '.' }, pinned: { pins: 'notices/pins.json', dir: 'notices/texts' } }\n`,
  )
  const run = (...args) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'tauri-kit-dev.js'), 'notices', '--config', join(app, 'notices.config.mjs'), ...args], { cwd: dir, encoding: 'utf8' })

  const written = run('--strict')
  assert.equal(written.status, 0, written.stderr)
  assert.match(written.stdout, /notices: 2 packages, 0 without a license text/)
  const text = readFileSync(join(app, 'out', 'NOTICES.txt'), 'utf8')
  assert.match(text, /^App — notices\n/)
  assert.match(text, /b 2\.0\.0\nLicense: ISC\nUpstream: https:\/\/www\.npmjs\.com\/package\/b\nLicense text from: https:\/\/src\/b\/LICENSE\n\nCopyright \(c\) B/)
  assert.equal(run('--check').status, 0, 'the file is what would be written')

  // A pin no shipped package uses, and a package left without a text: the first always fails, the second with --strict.
  pins({ 'c@3.0.0': { source: 'https://src/c/LICENSE', sha256 } })
  writeFileSync(join(app, 'node_modules', 'a', 'LICENSE'), '')
  const stale = run('--check')
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /pin c@3\.0\.0 applies to no shipped package/)
  assert.match(stale.stderr, /is not what would be written/)
  assert.match(stale.stderr, /without a license text: a 1\.0\.0/)
  pins()
  assert.equal(run().status, 0, 'without --strict a package without a text is only a warning')
  const strict = run('--strict')
  assert.equal(strict.status, 1)
  assert.match(strict.stderr, /a 1\.0\.0 ships without its license text — pin it/)
})
