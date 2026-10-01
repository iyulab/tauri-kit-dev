import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../src/args.js'

test('flags, options and positional arguments', () => {
  const args = parseArgs(['--history', 'a', '--config', 'c.js', 'b'], { flags: ['--history'], options: ['--config'] })
  assert.ok(args.flags.has('--history'))
  assert.equal(args.options['--config'], 'c.js')
  assert.deepEqual(args.positional, ['a', 'b'])
})

test('an unknown option or a missing value is an error', () => {
  assert.throws(() => parseArgs(['--histroy']), /unknown option: --histroy/)
  assert.throws(() => parseArgs(['--config'], { options: ['--config'] }), /needs a value/)
})
