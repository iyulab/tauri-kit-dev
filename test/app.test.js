import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { App, debugEnv, helpers, pictureName, runScenarios, selectScenarios } from '../src/app.js'

const names = ['open a folder', 'add a record', 'search', 'close']

test('every scenario once by default', () => {
  assert.deepEqual(selectScenarios(names, []), { selected: names, repeat: 1 })
})

test('--through stops at the first name containing the text; --repeat runs it over', () => {
  assert.deepEqual(selectScenarios(names, ['--through', 'record', '--repeat', '3']), { selected: names.slice(0, 2), repeat: 3 })
})

test('mistakes in the options are said, not guessed at', () => {
  assert.throws(() => selectScenarios(names, ['--throgh', 'x']), /unknown option: --throgh/)
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
