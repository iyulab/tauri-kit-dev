import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateArgs, listing, runGate, selectSteps, summary } from '../src/gate.js'

const STEPS = [
  { name: 'assemble', cmd: 'make helpers', optIn: '--ship' },
  { name: 'lint', cmd: 'npm run lint' },
  { name: 'test', cmd: 'npm test' },
  { name: 'clippy', cmd: 'cargo clippy', local: true },
  { name: 'e2e', cmd: 'npm run e2e', optIn: '--ship' },
]

const names = (steps) => steps.map((s) => s.name)

test('without arguments every step that does not opt in runs, in order', () => {
  assert.deepEqual(names(selectSteps(STEPS, gateArgs([], STEPS))), ['lint', 'test', 'clippy'])
})

test('an opt-in flag adds its steps where they stand', () => {
  assert.deepEqual(names(selectSteps(STEPS, gateArgs(['--ship'], STEPS))), ['assemble', 'lint', 'test', 'clippy', 'e2e'])
})

test('--only runs the named steps, opt-in ones included; --skip leaves steps out', () => {
  assert.deepEqual(names(selectSteps(STEPS, gateArgs(['--only', 'e2e,lint'], STEPS))), ['lint', 'e2e'])
  assert.deepEqual(names(selectSteps(STEPS, gateArgs(['--ship', '--skip', 'e2e,test'], STEPS))), ['assemble', 'lint', 'clippy'])
})

test('an unknown step, flag or missing value is an error', () => {
  assert.throws(() => gateArgs(['--only', 'lnit'], STEPS), /unknown step\(s\): lnit/)
  assert.throws(() => gateArgs(['--release'], STEPS), /unknown argument: --release/)
  assert.throws(() => gateArgs(['--skip'], STEPS), /--skip needs a value/)
})

test('the listing labels opt-in and local steps', () => {
  const lines = listing(STEPS)
  assert.match(lines[0], /^assemble\s+make helpers\s+\(--ship\)$/)
  assert.match(lines[3], /^clippy\s+cargo clippy\s+\(local only\)$/)
  assert.match(lines[1], /^lint\s+npm run lint$/)
})

test('the summary names what failed', () => {
  const { lines, ok } = summary([
    { name: 'lint', cmd: '', ok: true, seconds: 1.25 },
    { name: 'test', cmd: '', ok: false, seconds: 3, local: true },
  ])
  assert.equal(ok, false)
  assert.match(lines[0], /PASS {2}lint\s+1\.3s$/)
  assert.match(lines[1], /FAIL {2}test\s+3\.0s {2}\(local only\)$/)
  assert.equal(lines.at(-1), '1 failed: test')
})

function quiet() {
  const out = []
  return { out, log: (l) => out.push(l), error: (l) => out.push(l) }
}

test('every selected step runs even after one fails, and the exit code says so', () => {
  const ran = []
  const io = quiet()
  const code = runGate({
    steps: STEPS,
    run: (cmd) => {
      ran.push(cmd)
      return cmd !== 'npm run lint'
    },
    now: () => 0,
    ...io,
  })
  assert.equal(code, 1)
  assert.deepEqual(ran, ['npm run lint', 'npm test', 'cargo clippy'])
  assert.ok(io.out.includes('[gate] 1 failed: lint'))
})

test('all green is exit 0', () => {
  const io = quiet()
  assert.equal(runGate({ steps: STEPS, run: () => true, now: () => 0, ...io }), 0)
  assert.ok(io.out.includes('[gate] all green'))
})

test('preflight can refuse before anything runs, seeing what was selected', () => {
  let seen
  const io = quiet()
  const code = runGate({
    steps: STEPS,
    argv: ['--only', 'clippy'],
    preflight: (selected) => {
      seen = names(selected)
      return 'the debug build is running'
    },
    run: () => assert.fail('nothing runs'),
    ...io,
  })
  assert.equal(code, 2)
  assert.deepEqual(seen, ['clippy'])
  assert.ok(io.out.includes('[gate] the debug build is running'))
})

test('bad arguments do not start the gate', () => {
  const io = quiet()
  assert.equal(runGate({ steps: STEPS, argv: ['--onyl', 'x'], run: () => assert.fail('nothing runs'), ...io }), 2)
})

test('--list prints the steps and runs nothing', () => {
  const io = quiet()
  assert.equal(runGate({ steps: STEPS, argv: ['--list'], run: () => assert.fail('nothing runs'), ...io }), 0)
  assert.equal(io.out.length, STEPS.length)
})
