import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe as lines, logonCommand, parseResult, verdicts, withBom, wsbConfig } from '../src/sandbox.js'

const here = dirname(fileURLToPath(import.meta.url))

test('the logon command passes the app as parameters, in double quotes (-File keeps single quotes in the value)', () => {
  assert.equal(
    logonCommand({ inside: 'C:\\check', exe: "Bob's App.exe", identifier: 'com.example.app', extra: 'extra.ps1', withoutWebView2: true }),
    'powershell -NoProfile -ExecutionPolicy Bypass -File C:\\check\\inside.ps1 -Exe "Bob\'s App.exe" -Identifier "com.example.app" -Extra "extra.ps1" -WithoutWebView2',
  )
  assert.equal(logonCommand({ inside: 'C:\\check', exe: 'app.exe' }), 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\\check\\inside.ps1 -Exe "app.exe"')
  assert.throws(() => logonCommand({ inside: 'C:\\check', exe: 'a"b.exe' }), /double quote/)
})

// Run the real thing where it can run: the command line as the sandbox would, its value read back.
test('a quoted argument reaches the script without its quotes', { skip: process.platform !== 'win32' && 'Windows PowerShell only' }, async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'logon-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'inside.ps1'), 'param([string]$Exe, [string]$Identifier) "[$Exe][$Identifier]"')
  const command = logonCommand({ inside: dir, exe: "My App's.exe", identifier: 'com.example.app' })
  const r = spawnSync('cmd', ['/d', '/s', '/c', `"${command}"`], { encoding: 'utf8', windowsVerbatimArguments: true })
  assert.equal(r.stdout.trim(), "[My App's.exe][com.example.app]", r.stderr)
})

test('the .wsb turns networking off and escapes what it embeds', () => {
  const config = wsbConfig({ hostFolder: 'C:\\Temp\\a&b', inside: 'C:\\check', command: 'run <this>' })
  assert.match(config, /<Networking>Disable<\/Networking>/)
  assert.match(config, /<HostFolder>C:\\Temp\\a&amp;b<\/HostFolder>/)
  assert.match(config, /<Command>run &lt;this&gt;<\/Command>/)
})

test('scripts for Windows PowerShell 5.1 carry exactly one byte order mark', () => {
  assert.equal(withBom('x'), '\uFEFFx')
  assert.equal(withBom('\uFEFFx'), '\uFEFFx')
})

test('a result is read only once it parses', () => {
  assert.equal(parseResult('{"ok": tr'), undefined)
  assert.deepEqual(parseResult('\uFEFF{"ok":true,"steps":[]}'), { ok: true, steps: [] })
})

const passing = {
  ok: true,
  steps: [
    { name: 'network', ok: true, value: 'offline' },
    { name: 'webview2 before', ok: true, value: null },
    { name: 'install', ok: true, value: 'app.exe, uninstall.exe' },
    { name: 'webview2 after', ok: true, value: '140.0 (HKCU) - files in X' },
  ],
}

test('a passing run passes, also without WebView2', () => {
  assert.deepEqual(verdicts(passing, { withoutWebView2: true }).filter(([ok]) => !ok), [])
})

test('a sandbox with a network, or a failed step, does not pass', () => {
  const online = { ...passing, steps: passing.steps.map((s) => (s.name === 'network' ? { ...s, value: 'online' } : s)) }
  assert.deepEqual(verdicts(online).filter(([ok]) => !ok).map(([, what]) => what), ['the sandbox has no network'])
  const failed = { ...passing, ok: false }
  assert.deepEqual(verdicts(failed).filter(([ok]) => !ok).map(([, what]) => what), ['every step in the sandbox passed'])
})

test('a registration without runtime files is called out as the sandbox, not the installer', () => {
  const before = { name: 'webview2 before', ok: true, value: '1.0 (HKLM) - no runtime files on disk' }
  const broken = { ...passing, steps: passing.steps.map((s) => (s.name === before.name ? before : s)) }
  assert.ok(lines(broken).some((l) => l.includes('registers a WebView2 runtime whose files are missing')))
})

// The script runs inside the sandbox only; here it is at least parsed, wherever PowerShell is.
const pwsh = ['pwsh', 'powershell'].find((p) => spawnSync(p, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }).status === 0)
test('the script inside the sandbox parses', { skip: !pwsh && 'no PowerShell on this machine' }, () => {
  const file = join(here, '..', 'src', 'sandbox', 'inside.ps1').replaceAll("'", "''")
  const r = spawnSync(pwsh, ['-NoProfile', '-Command', `$e = $null; [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e) | Out-Null; $e.Count`], { encoding: 'utf8' })
  assert.equal(r.stdout.trim(), '0', r.stdout + r.stderr)
})
