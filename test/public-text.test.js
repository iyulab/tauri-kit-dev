import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALLOW_MARK, DEFAULT_RULES, checkRepo, markedAllowed, rulesOf, scan } from '../src/public-text.js'

const whys = (text, rules) => scan(text, rules).map((f) => f.why)
// Built at run time, so this file does not itself carry what it tests for.
const userPath = ['C:', 'Users', 'someone', 'project'].join('\\')
const homePath = ['', 'home', 'someone', 'src'].join('/')
const privateHost = ['192', '168', '0', '7'].join('.')

test('local paths and private hosts are found by default', () => {
  assert.deepEqual(whys(`opened ${userPath}`), ['local path'])
  assert.deepEqual(whys(`cd ${homePath}`), ['local path'])
  assert.deepEqual(whys(`http://${privateHost}:8080`), ['private host'])
  assert.deepEqual(whys(`db.corp.${'inter' + 'nal'}`), ['private host'])
})

test('text encoded twice is found', () => {
  // Each built from the UTF-8 bytes of a character read back one byte per character.
  const twice = (text, decode) => [...Buffer.from(text, 'utf8')].map(decode).join('')
  const latin1 = (b) => String.fromCharCode(b)
  const cp1252 = (b) => new TextDecoder('windows-1252').decode(Uint8Array.of(b))
  for (const text of ['a dash \u2014 here', 'caf\u00e9', '\u201cquoted\u201d', '\u00a0nbsp']) {
    assert.deepEqual(whys(twice(text, latin1)), ['encoded twice'], `latin-1: ${text}`)
    assert.deepEqual(whys(twice(text, cp1252)), ['encoded twice'], `cp1252: ${text}`)
  }
  for (const line of ['a dash \u2014 here', 'caf\u00e9 cr\u00e8me', 'S\u00e3o Paulo', '\u00ab quoted \u00bb \u00b7 \u00a9 2026', '\u00c9cole \u00c0 bient\u00f4t']) {
    assert.deepEqual(scan(line), [], line)
  }
})

test('ordinary text is left alone', () => {
  for (const line of ['see /usr/local/bin', 'version 10.0.26100', 'import x from "./home/page.js"', 'C:\\Windows\\System32']) {
    assert.deepEqual(scan(line), [], line)
  }
})

test("a config's rules follow the defaults, or replace them", () => {
  const forbidden = [{ why: 'name', re: /\bsecret-project\b/ }]
  assert.equal(rulesOf({ forbidden }).length, DEFAULT_RULES.length + 1)
  assert.deepEqual(rulesOf({ forbidden, defaults: false }), forbidden)
  assert.deepEqual(whys(`secret-project at ${userPath}`, rulesOf({ forbidden })), ['local path', 'name'])
})

test('a repository: tracked files, unpushed messages, and history', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'public-text-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  git('init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'mentions secret-project\n')
  git('add', '.')
  git('commit', '-qm', 'add a')
  writeFileSync(join(repo, 'a.txt'), 'clean now\n')
  writeFileSync(join(repo, 'b.txt'), 'fine\nalso secret-project\n')
  git('add', '.')
  git('commit', '-qm', 'per secret-project')
  const config = { forbidden: [{ why: 'name', re: /\bsecret-project\b/ }], allowed: [] }

  const now = checkRepo(repo, { config })
  assert.deepEqual(now.map((f) => f.where.replace(/@\w+/, '@<hash>')).sort(), ['@<hash>', 'b.txt:2'])

  const allowed = checkRepo(repo, { config: { ...config, allowed: ['b.txt:also'] } })
  assert.equal(allowed.filter((f) => f.where === 'b.txt:2').length, 0)

  const history = checkRepo(repo, { config, history: true })
  assert.ok(history.some((f) => f.where.endsWith(':a.txt') && f.why === 'name (history)'), 'a line removed since is still found')
})

test('without an upstream, a branch made from a pushed one is checked for its own messages only', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'public-text-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  git('init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'fine\n')
  git('add', '.')
  git('commit', '-qm', 'old secret-project message, already public')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('switch', '-qc', 'feature')
  git('commit', '-q', '--allow-empty', '-m', 'per secret-project, not pushed')
  const config = { forbidden: [{ why: 'name', re: /\bsecret-project\b/ }], allowed: [] }
  const hashOf = (rev) => git('rev-parse', '--short', rev).trim()

  assert.deepEqual(checkRepo(repo, { config }).map((f) => f.where), [`@${hashOf('HEAD')}`])

  // A detached HEAD — how CI checks a commit out — counts every commit.
  git('switch', '-q', '--detach')
  assert.equal(checkRepo(repo, { config }).length, 2)
})

test('a file whose path holds characters outside ASCII is checked too', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'public-text-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  git('init', '-q')
  writeFileSync(join(repo, 'nötes 日記.md'), 'mentions secret-project\n')
  git('add', '.')
  git('commit', '-qm', 'add notes')
  const found = checkRepo(repo, { config: { forbidden: [{ why: 'name', re: /\bsecret-project\b/ }] } })
  assert.deepEqual(found.map((f) => f.where), ['nötes 日記.md:1'])
})

test('what is read is the committed text of each file, not the working tree', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'public-text-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  git('init', '-q')
  for (let i = 0; i < 40; i++) writeFileSync(join(repo, `f${i}.txt`), `${'é'.repeat(i)}\nline ${i}${i === 17 ? ' secret-project' : ''}\n`)
  writeFileSync(join(repo, 'empty.txt'), '')
  git('add', '.')
  git('commit', '-qm', 'files')
  writeFileSync(join(repo, 'f17.txt'), 'clean in the working tree only\n')
  writeFileSync(join(repo, 'staged.txt'), 'secret-project, staged and not committed\n')
  git('add', 'staged.txt')
  const found = checkRepo(repo, { config: { forbidden: [{ why: 'name', re: /\bsecret-project\b/ }] } })
  assert.deepEqual(found.map((f) => f.where), ['f17.txt:2'])
})

test('a line marked as allowed, on itself or just above, is left alone', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'public-text-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  git('init', '-q')
  const mark = ['public-text', 'allow'].join(': ')
  writeFileSync(join(repo, 'fixture.js'), [
    `const a = '${userPath}' // ${mark} — the test is about home folders`,
    `// ${mark} — same, written above`,
    `const b = '${userPath}'`,
    '',
    `const c = '${userPath}'`,
  ].join('\n'))
  git('add', '.')
  git('commit', '-qm', 'fixtures')

  assert.deepEqual(checkRepo(repo).map((f) => f.where), ['fixture.js:5'])
  assert.deepEqual(
    checkRepo(repo, { history: true }).filter((f) => f.why.endsWith('(history)')).map((f) => f.text),
    [`const c = '${userPath}'`],
  )
})

test('markedAllowed looks at the line and the one above, nothing further', () => {
  const lines = ['x', `// ${ALLOW_MARK}`, 'y', 'z']
  assert.equal(markedAllowed(lines, 0), false)
  assert.equal(markedAllowed(lines, 1), true)
  assert.equal(markedAllowed(lines, 2), true)
  assert.equal(markedAllowed(lines, 3), false)
})
