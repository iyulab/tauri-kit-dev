import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RULES, checkRepo, rulesOf, scan } from '../src/public-text.js'

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
