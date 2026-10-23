import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { App, consoleLine, consoleMessage, webviewGone, debugEnv, debugPortDiagnosis, helpers, pictureName, runScenarios, selectScenarios } from '../src/app.js'

const names = ['open a folder', 'add a record', 'search', 'close']

test('every scenario once by default', () => {
  assert.deepEqual(selectScenarios(names, []), { selected: names, repeat: 1 })
})

test('--through stops at the first name containing the text; --repeat runs it over', () => {
  assert.deepEqual(selectScenarios(names, ['--through', 'record', '--repeat', '3']), { selected: names.slice(0, 2), repeat: 3 })
})

test('--only keeps the scenarios whose names contain the text, in order, and nothing before them', () => {
  assert.deepEqual(selectScenarios(names, ['--only', ' a ', '--repeat', '2']), { selected: ['open a folder', 'add a record'], repeat: 2 })
  assert.deepEqual(selectScenarios(names, ['--only', 'search']), { selected: ['search'], repeat: 1 })
})

test('mistakes in the options are said, not guessed at', () => {
  assert.throws(() => selectScenarios(names, ['--throgh', 'x']), /unknown option: --throgh/)
  assert.throws(() => selectScenarios(names, ['--through', 'search', '--only', 'search']), /give one of them/)
  assert.throws(() => selectScenarios(names, ['--only', 'nothing like it']), /no scenario name contains/)
  assert.throws(() => selectScenarios(names, ['--repeat', '0']), /whole number/)
  assert.throws(() => selectScenarios(names, ['--through', 'nothing like it']), /no scenario name contains/)
})

test('picture names keep letters of any script', () => {
  assert.equal(pictureName('기록 추가: 첫 번째'), '기록-추가-첫-번째.png')
  assert.equal(pictureName('FAILED open/close'), 'FAILED-open-close.png')
})

test('the debugging port is added to arguments WebView2 already has', () => {
  assert.deepEqual(debugEnv(9230, {}), { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9230' })
  assert.deepEqual(debugEnv(9230, { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--lang=ko' }), {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--lang=ko --remote-debugging-port=9230',
  })
})

test('the in-page helpers are a script that defines them under the given name', () => {
  const window = {}
  new Function('window', 'document', helpers('__t'))(window, {})
  assert.equal(typeof window.__t.all, 'function')
  assert.equal(typeof window.__t.target, 'function')
})

/** The helpers in a window that only records its capture listeners, and a press that walks `path`. */
function pressing() {
  const listeners = []
  const window = { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) }
  new Function('window', 'document', helpers('__t'))(window, {})
  const press = (path, types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) =>
    types.map((type) => {
      const e = { type, composedPath: () => path, stopped: false, prevented: false }
      e.stopImmediatePropagation = () => (e.stopped = true)
      e.preventDefault = () => (e.prevented = true)
      for (const l of listeners) if (l.type === type) l.fn(e)
      return e
    })
  return { h: window.__t, listeners, press }
}

test('a press that lands on the armed element goes through, and disarm says it landed', () => {
  const { h, listeners, press } = pressing()
  const button = { disabled: false, hasAttribute: () => false }
  h.arm(button)
  assert.ok(listeners.every((l) => l.capture), 'the listeners see the press before the page does')
  const events = press([{}, button, {}])
  assert.ok(events.every((e) => !e.stopped && !e.prevented))
  assert.equal(h.disarm(), true)
})

test('a press that hits something else, or the element turned off, is kept from the page and counts as missed', () => {
  const { h, press } = pressing()
  const button = { disabled: false, hasAttribute: () => false }
  h.arm(button)
  assert.ok(press([{ other: true }]).every((e) => e.stopped && e.prevented), 'what it hit instead never hears it')
  assert.equal(h.disarm(), false)

  h.arm(button)
  button.disabled = true
  assert.ok(press([button]).every((e) => e.stopped))
  assert.equal(h.disarm(), false)

  h.arm(button)
  assert.equal(h.disarm(), false, 'a press that never arrived did not land')
  const after = press([{ other: true }])
  assert.ok(after.every((e) => !e.stopped), 'disarmed, the listeners let every press by')
})

test('an element turned off between the press going down and up gets no click: the press missed', () => {
  const { h, press } = pressing()
  const button = { disabled: false, hasAttribute: () => false, isConnected: true }
  h.arm(button)
  press([button], ['pointerdown', 'mousedown'])
  button.disabled = true
  // A turned-off control gets its pointer up but no mouse up and no click.
  press([button], ['pointerup'])
  assert.equal(h.disarm(), false)
})

test('an element the press took away before its click did its work: the press landed', () => {
  const { h, press } = pressing()
  const item = { disabled: false, hasAttribute: () => false, isConnected: true }
  h.arm(item)
  press([item], ['pointerdown', 'mousedown'])
  item.isConnected = false
  const [, , click] = press([{ other: true }], ['pointerup', 'mouseup', 'click'])
  assert.ok(click.stopped, 'the click that fell where it was is kept from the page')
  assert.equal(h.disarm(), true)

  h.arm(item)
  item.isConnected = true
  press([item], ['pointerdown', 'mousedown'])
  item.isConnected = false
  assert.equal(h.disarm(), true, 'gone with no click at all')
})

test('click tries again when the press missed, and says so when it keeps missing', async () => {
  const clicks = []
  let landed = [false, true]
  const app = new App()
  app.cdp = { waitFor: async () => ({ x: 1, y: 2 }), clickAt: async (b) => clicks.push(b), evaluate: async () => landed.shift() }
  await app.click('dc-button', '산출')
  assert.equal(clicks.length, 2)

  landed = [false, false, false]
  await assert.rejects(app.click('dc-button', '산출', { attempts: 3 }), /missed it 3 times/)
  assert.equal(clicks.length, 5)
})

test('a launch refuses a port that already answers — an earlier window would answer in its place', async (t) => {
  const server = createServer((_, res) => res.end('{}'))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  await assert.rejects(App.launch({ exe: 'never-started', port: server.address().port }), /already answers on debugging port/)
})

test('runScenarios runs in order, stops at a failure, and says what the window showed', async () => {
  const ran = []
  const lines = []
  const app = { child: {}, quit: async () => ran.push('quit') }
  const code = await runScenarios(
    {
      first: async () => ran.push('first'),
      second: async () => {
        throw new Error('timed out waiting for the list')
      },
      third: async () => ran.push('third'),
    },
    { start: async () => ({ app, stop: async () => ran.push('stop') }), argv: [], screenshots: undefined, shown: async () => 'Could not open', log: (l) => lines.push(l) },
  )
  assert.equal(code, 1)
  assert.deepEqual(ran, ['first', 'quit', 'stop'])
  assert.match(lines.join('\n'), /✗ second\n {4}timed out waiting for the list\n {4}the window showed: Could not open/)
})

test('runScenarios fails a scenario that never finishes, says so, and goes on to quit — a window that stopped answering cannot hold the run', async () => {
  const ran = []
  const lines = []
  const never = new Promise(() => {})
  const app = { child: {}, cdp: { screenshot: () => never }, quit: async () => ran.push('quit') }
  const started = Date.now()
  const code = await runScenarios(
    { hangs: () => never, after: async () => ran.push('after') },
    { start: async () => ({ app }), argv: [], screenshots: undefined, failures: undefined, shown: () => never, scenarioTimeoutMs: 50, log: (l) => lines.push(l) },
  )
  assert.equal(code, 1)
  assert.deepEqual(ran, ['quit'])
  assert.match(lines.join('\n'), /✗ hangs\n {4}did not finish within 0\.05 s/)
  assert.ok(Date.now() - started < 5_000, 'what the failure gathers is let go too')
})

test('runScenarios survives a scenario it let go failing afterwards, as a hung one does once its window is quit', async () => {
  const lines = []
  let unhandled = 0
  const count = () => unhandled++
  process.on('unhandledRejection', count)
  try {
    const app = { quit: async () => {} }
    const code = await runScenarios(
      { late: () => new Promise((_, reject) => setTimeout(() => reject(new Error('connection closed')), 100)) },
      { start: async () => ({ app }), argv: ['--repeat', '2'], scenarioTimeoutMs: 20, log: (l) => lines.push(l) },
    )
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(code, 1)
    assert.equal(unhandled, 0)
    assert.match(lines.at(-1), /0 of 2 runs passed — failed: late/)
  } finally {
    process.off('unhandledRejection', count)
  }
})

test('runScenarios keeps a picture of a failure without being asked for pictures, and says where', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const failures = join(mkdtempSync(join(tmpdir(), 'runs-')), 'failed')
  const lines = []
  const app = { child: {}, cdp: { screenshot: async () => Buffer.from('png') }, quit: async () => {} }
  const code = await runScenarios(
    { 'opens: the list': async () => { throw new Error('no list') } },
    { start: async () => ({ app }), argv: [], screenshots: undefined, failures, log: (l) => lines.push(l) },
  )
  assert.equal(code, 1)
  assert.deepEqual(readdirSync(failures), ['FAILED-opens-the-list.png'])
  assert.ok(lines.includes(`    picture: ${join(failures, 'FAILED-opens-the-list.png')}`))
})

test('runScenarios with --repeat starts fresh each run and counts the runs that passed', async () => {
  let starts = 0
  const lines = []
  const code = await runScenarios(
    { only: async () => {} },
    { start: async () => (starts++, { app: { quit: async () => {} } }), argv: ['--repeat', '2'], log: (l) => lines.push(l) },
  )
  assert.equal(code, 0)
  assert.equal(starts, 2)
  assert.match(lines.at(-1), /2 of 2 runs passed/)
})

test("an app's own subclass launches as itself, so its own methods are there after a launch", () => {
  // Launching needs a real window; what matters is what launch constructs — the class it was called on.
  assert.match(App.launch.toString(), /new this\(\)/)
  assert.match(App.prototype.restart.toString(), /this\.constructor\.launch/)
})

test('waiting for a web view profile takes an app identifier, and has nothing to wait for off Windows', async () => {
  await assert.rejects(webviewGone("x' ; Stop-Computer", { platform: 'win32' }), /takes an app identifier/)
  await webviewGone('com.example.app', { platform: 'linux' })
})

test('a window whose port never opened is told apart by its browser command line', () => {
  const browser = (args) => `"msedgewebview2.exe" --embedded-browser-webview=1 --webview-exe-name=my-app.exe ${args} --lang=en-US`
  const renderer = '"msedgewebview2.exe" --type=renderer --webview-exe-name=my-app.exe --remote-debugging-port=9233'
  const other = '"msedgewebview2.exe" --webview-exe-name=other-app.exe --remote-debugging-port=9233'

  // No browser for this app — not even one from another app on the same port counts.
  assert.match(debugPortDiagnosis(9233, 'my-app.exe', [other]), /no WebView2 browser was started for my-app\.exe/)
  // A browser without the port: the variable never reached it — say so, and where the remedy is.
  const said = debugPortDiagnosis(9233, 'my-app.exe', [browser('--disable-features=X'), renderer])
  assert.match(said, /started without --remote-debugging-port=9233/)
  assert.match(said, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/)
  assert.match(said, /Opening the debugging port/)
  // Another port is not this port.
  assert.match(debugPortDiagnosis(9233, 'my-app.exe', [browser('--remote-debugging-port=92330')]), /started without/)
  // The browser carried the port: the cause lies elsewhere, nothing to add.
  assert.equal(debugPortDiagnosis(9233, 'my-app.exe', [browser('--remote-debugging-port=9233')]), undefined)
})

test('a run that ends without quitting takes its window with it', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFile } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'tkd-end-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pidFile = join(dir, 'pid')
  // The "window": a process that notes its id and stays. The run launches it, then exits without quitting.
  const window = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
  const run = `import { App } from ${JSON.stringify(new URL('../src/app.js', import.meta.url).href)}
    setTimeout(() => process.exit(3), 1500)
    await App.launch({ exe: process.execPath, args: ['-e', ${JSON.stringify(window)}], port: 1, timeoutMs: 60_000 })`
  const code = await new Promise((done) => execFile(process.execPath, ['--input-type=module', '-e', run]).on('exit', done))
  assert.equal(code, 3)
  const pid = Number(await readFile(pidFile, 'utf8'))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100))
  if (alive()) process.kill(pid)
  assert.equal(alive(), false)
})

test('a console call is one message: its arguments as printed, an assert as an error', () => {
  assert.deepEqual(consoleMessage({ type: 'warning', args: [{ type: 'string', value: 'IPC failed' }, { type: 'object', description: 'TypeError: Failed to fetch' }] }), {
    level: 'warning',
    text: 'IPC failed TypeError: Failed to fetch',
  })
  assert.deepEqual(consoleMessage({ type: 'assert', args: [{ type: 'number', value: 0 }] }), { level: 'error', text: '0' })
  assert.deepEqual(consoleMessage({ type: 'table', args: [{ type: 'undefined' }] }), { level: 'log', text: 'undefined' })
})

test('consoleProblems keeps the warnings and errors; a failure report says how many and the last few', () => {
  const app = new App()
  app.consoleMessages = [
    { level: 'log', text: 'ready' },
    { level: 'warning', text: 'first' },
    { level: 'error', text: 'Refused to connect\nbecause of the policy', source: 'security' },
    { level: 'info', text: 'fine' },
  ]
  assert.deepEqual(app.consoleProblems().map((m) => m.text), ['first', 'Refused to connect\nbecause of the policy'])
  assert.equal(consoleLine(app), 'the page said 2 warnings or errors: warning: first · error: Refused to connect')
  assert.equal(consoleLine(app, 1), 'the page said 2 warnings or errors, the last 1: error: Refused to connect')
  assert.equal(consoleLine(new App()), '')
})

test('runScenarios adds what the page said to a failure', async () => {
  const lines = []
  const app = { child: {}, quit: async () => {}, consoleProblems: () => [{ level: 'warning', text: 'IPC custom protocol failed' }] }
  await runScenarios(
    { only: async () => { throw new Error('the list is empty') } },
    { start: async () => ({ app }), argv: [], screenshots: undefined, log: (l) => lines.push(l) },
  )
  assert.match(lines.join('\n'), /✗ only\n {4}the list is empty\n {4}the page said one warning or error: warning: IPC custom protocol failed/)
})
