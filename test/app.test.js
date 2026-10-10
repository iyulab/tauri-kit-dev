import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { App, webviewGone, debugEnv, debugPortDiagnosis, helpers, pictureName, runScenarios, selectScenarios } from '../src/app.js'

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
  const press = (path) =>
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].map((type) => {
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
