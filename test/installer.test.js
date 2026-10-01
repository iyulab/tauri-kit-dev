import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { nsisArgs, pickInstaller, pickUpgradeFrom, profileSnapshots } from '../src/installer.js'

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
