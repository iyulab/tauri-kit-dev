import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpVersions, checkVersions, isVersion } from '../src/versions.js'

/** An app's files that hold its version, each written as its tool writes it. */
function app(version, { lockRoot = version } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'versions-'))
  const write = (name, text) => writeFileSync(join(dir, name), text)
  write(
    'Cargo.toml',
    `[package]\nname = "notes"\nversion = "${version}" # the app\nedition = "2021"\n\n[dependencies]\nserde = { version = "1.0.0" }\n`,
  )
  write(
    'Cargo.lock',
    `version = 4\n\n[[package]]\nname = "aho"\nversion = "1.1.3"\n\n[[package]]\nname = "notes"\nversion = "${version}"\ndependencies = [\n "serde",\n]\n`,
  )
  write('tauri.conf.json', `{\n  "productName": "Notes",\n  "version": "${version}",\n  "plugins": { "updater": { "version": "2" } }\n}\n`)
  write('package.json', `{\n\t"name": "notes",\n\t"version": "${version}",\n\t"dependencies": { "lit": "^3.0.0" }\n}\n`)
  write(
    'package-lock.json',
    `{\n  "name": "notes",\n  "version": "${version}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "notes",\n      "version": "${lockRoot}"\n    },\n    "node_modules/lit": {\n      "version": "3.2.0"\n    }\n  }\n}\n`,
  )
  write('Helper.csproj', `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <Version>${version}</Version>\n  </PropertyGroup>\n</Project>\n`)
  const files = ['Cargo.toml', { file: 'Cargo.lock', package: 'notes' }, 'tauri.conf.json', 'package.json', 'package-lock.json', 'Helper.csproj']
  return { dir, files, at: (f) => join(dir, f), read: (f) => readFileSync(join(dir, f), 'utf8') }
}

test('a version is major.minor.patch, with a prerelease or build part if any', () => {
  assert.ok(isVersion('0.3.0') && isVersion('1.2.3-beta.1') && isVersion('1.2.3+build.5'))
  assert.ok(!isVersion('1.2') && !isVersion('v1.2.3') && !isVersion('1.2.3.4'))
})

test('reads the version each kind of file holds — its own, not a dependency’s — and says they agree', () => {
  const { files, at } = app('0.2.0')
  const report = checkVersions(files, at)
  assert.equal(report.agree, true)
  assert.equal(report.version, '0.2.0')
  assert.deepEqual(
    report.found.map((f) => f.version),
    ['0.2.0', '0.2.0', '0.2.0', '0.2.0', '0.2.0', '0.2.0'],
  )
})

test('names the file that disagrees, and one whose two places disagree within it', () => {
  const { files, at, dir } = app('0.2.0', { lockRoot: '0.1.0' })
  writeFileSync(join(dir, 'tauri.conf.json'), readFileSync(join(dir, 'tauri.conf.json'), 'utf8').replace('"0.2.0"', '"0.1.9"'))
  const report = checkVersions(files, at)
  assert.equal(report.agree, false)
  assert.equal(report.found.find((f) => f.file === 'tauri.conf.json').version, '0.1.9')
  assert.match(report.found.find((f) => f.file === 'package-lock.json').problem, /0\.2\.0, 0\.1\.0/)
})

test('moves every file to the new version, each in place, leaving the rest of its text as written', () => {
  const { files, at, read } = app('0.2.0')
  const before = { toml: read('Cargo.toml'), lock: read('Cargo.lock'), pkg: read('package.json') }
  bumpVersions(files, '0.3.0', at)
  assert.equal(checkVersions(files, at).version, '0.3.0')
  assert.equal(read('Cargo.toml'), before.toml.replace('version = "0.2.0"', 'version = "0.3.0"'))
  assert.match(read('Cargo.toml'), /serde = \{ version = "1\.0\.0" \}/)
  assert.equal(read('Cargo.lock'), before.lock.replace('name = "notes"\nversion = "0.2.0"', 'name = "notes"\nversion = "0.3.0"'))
  assert.equal(read('package.json'), before.pkg.replace('"0.2.0"', '"0.3.0"'))
  assert.match(read('tauri.conf.json'), /"updater": \{ "version": "2" \}/)
  assert.match(read('package-lock.json'), /"node_modules\/lit": \{\n {6}"version": "3\.2\.0"/)
})

test('writes nothing when a file holds no version it can find, and refuses what is not a version', () => {
  const { files, at, dir, read } = app('0.2.0')
  writeFileSync(join(dir, 'Helper.csproj'), '<Project />\n')
  const toml = read('Cargo.toml')
  assert.throws(() => bumpVersions(files, '0.3.0', at), /Helper\.csproj: no version found/)
  assert.equal(read('Cargo.toml'), toml)
  assert.throws(() => bumpVersions(files.slice(0, 1), '0.3', at), /not a version/)
})

test('a workspace manifest holds its version under [workspace.package]; a lock entry needs the crate named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'versions-'))
  writeFileSync(join(dir, 'Cargo.toml'), '[workspace]\nmembers = ["a"]\n\n[workspace.package]\nversion = "1.4.0"\n')
  assert.equal(checkVersions(['Cargo.toml'], (f) => join(dir, f)).version, '1.4.0')
  writeFileSync(join(dir, 'Cargo.lock'), 'version = 4\n')
  assert.throws(() => checkVersions(['Cargo.lock'], (f) => join(dir, f)), /needs \{ package \}/)
})
