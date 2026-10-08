import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nsisArgs, pickInstaller, pickReleaseInstaller, pickUpgradeFrom, profileSnapshots, withAppDataSetAside } from '../src/installer.js'

test('NSIS: silent, and the folder last and unquoted', () => {
  assert.deepEqual(nsisArgs('C:\\Temp\\my app'), ['/S', '/D=C:\\Temp\\my app'])
})

test('the installer of this version, not an earlier one left beside it', () => {
  const files = ['App_0.1.2_x64-setup.exe', 'App_0.1.3_x64-setup.exe', 'App_0.1.3_x64-offline-setup.exe']
  assert.equal(pickInstaller(files, { version: '0.1.3' }), 'App_0.1.3_x64-setup.exe')
  assert.equal(pickInstaller(files, { version: '0.1.3', suffix: '_x64-offline-setup.exe' }), 'App_0.1.3_x64-offline-setup.exe')
  assert.equal(pickInstaller(files, { version: '0.2.0' }), undefined)
})

test('the version to update from: the newest published one that is not this one', () => {
  const releases = [
    { tagName: 'v0.1.2', publishedAt: '2026-09-20T00:00:00Z' },
    { tagName: 'v0.1.4', publishedAt: '2026-09-30T00:00:00Z' },
    { tagName: 'v0.1.3', publishedAt: '2026-09-25T00:00:00Z' },
  ]
  assert.equal(pickUpgradeFrom(releases, '0.1.5'), 'v0.1.4')
  assert.equal(pickUpgradeFrom(releases, '0.1.4'), 'v0.1.3')
  assert.equal(pickUpgradeFrom(releases, '0.1.4', 'v0.1.2'), 'v0.1.2')
  assert.equal(pickUpgradeFrom([], '0.1.0'), undefined)
})

test('profile snapshots sit under the web view folder of the app data', () => {
  assert.equal(profileSnapshots(join('data', 'com.example.app')), join('data', 'com.example.app', 'EBWebView', 'Snapshots'))
})

test('picks the installer of a release that also carries a copy without the version', () => {
  const files = ['App_0.1.7_x64-setup.exe', 'App_x64-setup.exe', 'App_0.1.7_x64-offline-setup.exe', 'App_x64-offline-setup.exe']
  assert.equal(pickReleaseInstaller(files, { tag: 'v0.1.7' }), 'App_0.1.7_x64-setup.exe')
  assert.equal(pickReleaseInstaller(files, { tag: 'v0.1.7', pattern: '*_x64-offline-setup.exe' }), 'App_0.1.7_x64-offline-setup.exe')
})

test('a release with one installer is picked whatever it is named', () => {
  assert.equal(pickReleaseInstaller(['App_x64-setup.exe', 'latest.json'], { tag: 'v2.0.0' }), 'App_x64-setup.exe')
})

test('no installer, or several of the same version, is not a pick', () => {
  assert.equal(pickReleaseInstaller(['latest.json'], { tag: 'v0.1.7' }), null)
  assert.equal(pickReleaseInstaller(['A_0.1.7_x64-setup.exe', 'B_0.1.7_x64-setup.exe'], { tag: 'v0.1.7' }), null)
})

test('a data folder set aside comes back as it was, and what the check wrote is gone', async () => {
  const base = await mkdtemp(join(tmpdir(), 'kit-appdata-'))
  const appData = join(base, 'com.example.app')
  await mkdir(appData)
  await writeFile(join(appData, 'install-id'), 'mine')
  const seen = await withAppDataSetAside(appData, async () => {
    const before = existsSync(appData)
    await mkdir(join(appData, 'diagnostics'), { recursive: true })
    await writeFile(join(appData, 'diagnostics', 'sessions.jsonl'), 'a check session')
    return before
  })
  assert.equal(seen, false, 'the check starts from no data folder')
  assert.deepEqual(readdirSync(appData), ['install-id'])
  assert.equal(readFileSync(join(appData, 'install-id'), 'utf8'), 'mine')
  await rm(base, { recursive: true, force: true })
})

test('a data folder that was not there is not there afterwards, even when the check fails', async () => {
  const base = await mkdtemp(join(tmpdir(), 'kit-appdata-'))
  const appData = join(base, 'com.example.app')
  await assert.rejects(
    withAppDataSetAside(appData, async () => {
      await mkdir(appData)
      throw new Error('the check failed')
    }),
    /the check failed/,
  )
  assert.equal(existsSync(appData), false)
  await rm(base, { recursive: true, force: true })
})

test('a folder left aside by an earlier check is not overwritten', async () => {
  const base = await mkdtemp(join(tmpdir(), 'kit-appdata-'))
  const appData = join(base, 'com.example.app')
  await mkdir(`${appData}.set-aside`)
  let ran = false
  await assert.rejects(withAppDataSetAside(appData, async () => (ran = true)), /left from an earlier check/)
  assert.equal(ran, false)
  await rm(base, { recursive: true, force: true })
})
