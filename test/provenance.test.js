import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filesDigest, filesUnder, gitSourceState, judgeStamp, pendingDigest, readStamp, writeStamp } from '../src/provenance.js'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'provenance-'))
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
  mkdirSync(join(dir, 'helper'))
  writeFileSync(join(dir, 'helper', 'main.txt'), 'one')
  writeFileSync(join(dir, 'other.txt'), 'x')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  return { dir, git }
}

test('the source state follows the folder, not the rest of the repository', () => {
  const { dir, git } = repo()
  const before = gitSourceState(dir, 'helper')
  assert.equal(before.pending, null)
  writeFileSync(join(dir, 'other.txt'), 'y')
  git('commit', '-q', '-am', 'elsewhere')
  const after = gitSourceState(dir, 'helper')
  assert.equal(after.tree, before.tree)
  assert.notEqual(after.commit, before.commit)
})

test('uncommitted changes and untracked files give a digest that tells them apart', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'helper', 'main.txt'), 'two')
  const changed = pendingDigest(dir, 'helper')
  assert.match(changed, /^[0-9a-f]{64}$/)
  writeFileSync(join(dir, 'helper', 'new.txt'), 'n')
  const withNew = pendingDigest(dir, 'helper')
  assert.notEqual(withNew, changed)
  writeFileSync(join(dir, 'helper', 'new.txt'), 'm')
  assert.notEqual(pendingDigest(dir, 'helper'), withNew)
})

test('a files digest is the same wherever the folder is, and skips what it is told to', () => {
  const make = () => {
    const root = mkdtempSync(join(tmpdir(), 'digest-'))
    mkdirSync(join(root, 'pkg', 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(root, 'pkg', 'a.js'), 'a')
    writeFileSync(join(root, 'pkg', 'node_modules', 'dep', 'b.js'), 'b')
    writeFileSync(join(root, 'lock.json'), '{}')
    return root
  }
  const digestOf = (root) => filesDigest(root, [join(root, 'lock.json'), ...filesUnder(join(root, 'pkg'), { skip: ['node_modules'] })])
  const one = make()
  const two = make()
  assert.equal(filesUnder(join(one, 'pkg'), { skip: ['node_modules'] }).length, 1)
  assert.equal(digestOf(one), digestOf(two))
  writeFileSync(join(two, 'pkg', 'a.js'), 'changed')
  assert.notEqual(digestOf(one), digestOf(two))
})

test('stamps round-trip, and a missing one is null', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'stamp-')), 'deep', 'helper.json')
  assert.equal(readStamp(file), null)
  writeStamp(file, { tree: 't', outputSha256: 'o' })
  assert.deepEqual(readStamp(file), { tree: 't', outputSha256: 'o' })
})

test('a stamp matches, differs, or does not describe the output at all', () => {
  const record = { tree: 't1', pending: null, version: '1.0.0', commit: 'abc', outputSha256: 'o1' }
  const against = (expected, digest = 'o1') => judgeStamp(record, { digestKey: 'outputSha256', digest, expected })
  assert.equal(against({ tree: 't1', pending: null, version: '1.0.0' }).verdict, 'match')
  assert.equal(against({ tree: 't2', pending: null, version: '1.0.0' }).verdict, 'differs')
  assert.equal(against({ tree: 't1', pending: 'p', version: '1.0.0' }).verdict, 'differs')
  assert.equal(against({ tree: 't1' }, 'o2').verdict, 'unknown')
  assert.equal(judgeStamp(null, { digestKey: 'outputSha256', digest: 'o1', expected: {} }).verdict, 'unknown')
  assert.equal(against({ tree: 't1' }).built, record)
})

test('a field an older stamp never recorded cannot match', () => {
  const old = { tree: 't1', pending: null, outputSha256: 'o1' }
  assert.equal(judgeStamp(old, { digestKey: 'outputSha256', digest: 'o1', expected: { tree: 't1', version: null } }).verdict, 'differs')
})
