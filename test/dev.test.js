import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { App, endLeftovers, endTree, readDiscovery } from '../src/app.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A port nothing listens on. */
async function freePort() {
  const server = createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  await new Promise((r) => server.close(r))
  return port
}

test('a dev launch needs the folder its command runs in', async () => {
  await assert.rejects(App.launchDev({ port: 9 }), /needs \{ cwd \}/)
})

test('a dev command that ends before its window is ready says so, by its command', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dev-'))
  await assert.rejects(
    App.launchDev({ cwd, command: `"${process.execPath}" -e "process.exit(3)"`, port: await freePort(), timeoutMs: 20_000 }),
    /process\.exit\(3\)" exited with 3 before its window was ready/,
  )
})

test('ending a dev command ends what it started, not only the shell', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-'))
  const pidFile = join(dir, 'grandchild.pid')
  // A shell running node, which starts another node that writes its pid and waits — as `tauri dev` starts the app.
  const grandchild = join(dir, 'grandchild.js')
  const parent = join(dir, 'parent.js')
  // Each ends itself after 20 s, so a failing test leaves nothing running.
  writeFileSync(grandchild, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 20000)`)
  writeFileSync(parent, `require('child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 20000)`)
  const child = spawn(`"${process.execPath}" "${parent}"`, { shell: true, stdio: 'ignore', detached: process.platform !== 'win32' })
  child.unref()
  for (let i = 0; !existsSync(pidFile) && i < 100; i++) await sleep(100)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try {
    assert.ok(alive(pid), 'the grandchild runs')
    endTree(child)
    for (let i = 0; alive(pid) && i < 50; i++) await sleep(100)
    assert.ok(!alive(pid), 'the grandchild ended with the shell')
  } finally {
    if (alive(pid)) process.kill(pid)
  }
})

test('a discovery file is read once it is there and whole', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dev-')), 'discovery.json')
  setTimeout(() => writeFileSync(path, '{"port": 5'), 200)
  setTimeout(() => writeFileSync(path, '{"port": 51234, "pid": 7}'), 600)
  assert.deepEqual(await readDiscovery(path, { timeoutMs: 5000 }), { port: 51234, pid: 7 })
  await assert.rejects(readDiscovery(join(tmpdir(), 'never-written.json'), { timeoutMs: 300 }), /no discovery file/)
})

test('leftovers are executables named, and one not running is passed over', async () => {
  await assert.rejects(endLeftovers(['notes']), /executable names/)
  assert.deepEqual(await endLeftovers(['tauri-kit-dev-never-running.exe']), [])
  assert.deepEqual(await endLeftovers(['notes.exe'], { platform: 'linux' }), [])
})
