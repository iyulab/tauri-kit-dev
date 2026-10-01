// Which source a built helper was made from — so checks that use it test what they mean to.
//
// A helper an app bundles (a sidecar process, a bundled runtime with its packages) is often built
// into a git-ignored folder and not rebuilt when its source changes. After a branch switch it can
// be a build of other code entirely, and the checks that run it — an end-to-end suite, a smoke test
// of the bundled helper — then verify that other build and pass. The remedy: when the helper is
// assembled, write a stamp of what it was built from; when a check is about to use it, compare the
// stamp with what the check means to test.
//
// A stamp is a flat JSON record the app shapes. It names the built output by digest, so output
// replaced by hand reads as unknown instead of inheriting a stamp that is not its own, and it holds
// the fields that say what the output was built from — for a build from source, the source
// folder's git tree and a digest of anything uncommitted in it (`gitSourceState`); for something
// installed from a lock file, the version and the lock file's digest. `judgeStamp` compares the
// fields the app names with what they should be now. Keep stamps out of folders the installer
// bundles.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/** @param {string | Buffer} data */
export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout
}

/**
 * A digest of what is uncommitted under `pathspec` in the repository at `cwd` — changes against
 * HEAD and untracked files (not ignored ones) — or `null` when there is nothing.
 *
 * @param {string} cwd
 * @param {string} pathspec
 */
export function pendingDigest(cwd, pathspec) {
  const diff = git(cwd, 'diff', 'HEAD', '--binary', '--', pathspec)
  const untracked = git(cwd, 'ls-files', '--others', '--exclude-standard', '--', pathspec)
    .split('\n')
    .filter(Boolean)
    .sort()
  if (diff === '' && untracked.length === 0) return null
  return sha256(diff + '\0' + untracked.map((f) => `${f}\0${sha256(readFileSync(join(cwd, f)))}`).join('\n'))
}

/**
 * The source folder `path` as it stands in the repository at `cwd`: its committed tree, the commit
 * (for people to read — two commits can share a tree), and a digest of anything uncommitted in it.
 * A build of uncommitted work then matches that same uncommitted work, and nothing else.
 *
 * @param {string} cwd
 * @param {string} path a folder relative to the repository root
 * @returns {{ tree: string, commit: string, pending: string | null }}
 */
export function gitSourceState(cwd, path) {
  return {
    tree: git(cwd, 'rev-parse', `HEAD:${path}`).trim(),
    commit: git(cwd, 'rev-parse', '--short', 'HEAD').trim(),
    pending: pendingDigest(cwd, path),
  }
}

/**
 * Every file under `dir`, recursively, leaving out folders whose name is in `skip`.
 *
 * @param {string} dir
 * @param {{ skip?: string[] }} [options]
 */
export function filesUnder(dir, { skip = [] } = {}) {
  const files = []
  const walk = (at) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, e.name)
      if (e.isDirectory()) {
        if (!skip.includes(e.name)) walk(full)
      } else files.push(full)
    }
  }
  walk(dir)
  return files
}

/**
 * One digest for a set of files: each file's name relative to `root` (with `/`) and its content,
 * in name order — so the same files give the same digest wherever the folder is.
 *
 * @param {string} root
 * @param {string[]} files
 */
export function filesDigest(root, files) {
  const named = files.map((f) => [relative(root, f).split('\\').join('/'), f])
  named.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return sha256(named.map(([name, f]) => `${name}\0${sha256(readFileSync(f))}`).join('\n'))
}

/** The stamp at `file`, or `null` when there is none. @param {string} file */
export const readStamp = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null)

/** Writes a stamp, making its folder. @param {string} file @param {object} record */
export function writeStamp(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
}

/**
 * Compares a stamp with the output it should describe and the state it should have been built from.
 *
 *   unknown  no stamp, or `record[digestKey]` is not `digest` — the output is not the one stamped
 *   match    every field of `expected` equals the stamp's
 *   differs  otherwise — built from something else
 *
 * A field `expected` names that an older stamp never recorded counts as different: a stamp cannot
 * vouch for what it did not record.
 *
 * @param {object | null} record
 * @param {{ digestKey: string, digest: string, expected: object }} against
 * @returns {{ verdict: 'unknown' | 'match' | 'differs', built?: object }}
 */
export function judgeStamp(record, { digestKey, digest, expected }) {
  if (!record || record[digestKey] !== digest) return { verdict: 'unknown' }
  const same = Object.entries(expected).every(([key, value]) => key in record && record[key] === value)
  return { verdict: same ? 'match' : 'differs', built: record }
}
