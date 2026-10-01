// Finds text a public repository must not carry: by default local paths and private hosts, plus
// whatever a caller lists in its own config — internal names, record ids, anything else it keeps
// out of public view.
//
// The caller's list stays with the caller. A list of the names to keep out of a public repository,
// committed to that repository, would publish the very names it guards against; this module only
// takes the list as an argument.
//
// What is checked in a git repository:
//   - every tracked file as committed at HEAD
//   - the messages of commits not yet pushed (all commits when the branch has no upstream)
//   - with `history`: every commit message, every line any commit reachable from any ref ever
//     added (old versions of files stay readable once a repository is public), and tag messages
//
// Not covered, and worth checking by hand before a repository goes public: Actions run logs,
// issues, pull requests, wiki, releases and the repository description.

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/**
 * @typedef {{ why: string, re: RegExp }} Rule
 * @typedef {{ forbidden?: Rule[], allowed?: string[], defaults?: boolean, binary?: RegExp }} Config
 * @typedef {{ where: string, why: string, text: string }} Finding
 */

/** What no public repository should carry, whoever owns it. */
export const DEFAULT_RULES = [
  { why: 'local path', re: /\b[A-Za-z]:[\\/]Users[\\/]|(?:^|[\s'"`(=])\/(?:home|Users)\/[^/\s]+\// },
  { why: 'private host', re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|\.(?:internal)\b/ },
]

/**
 * Marks one line as meant to carry what a rule finds — a test fixture whose subject is a local
 * path, say. Written on that line or on the line just above it, best followed by why:
 * `// public-text: allow — the test is about home folders`.
 */
export const ALLOW_MARK = 'public-text: allow'

/** True when line `index` of `lines` (0-based) carries the allow mark, or the line above it does. */
export function markedAllowed(lines, index) {
  return lines[index]?.includes(ALLOW_MARK) === true || (index > 0 && lines[index - 1]?.includes(ALLOW_MARK) === true)
}

/** Files whose bytes are not text, or whose text is generated. */
export const BINARY = /\.(png|jpe?g|gif|ico|icns|webp|woff2?|ttf|otf|mp4|webm|pdf|zip|exe|dll|lock)$|package-lock\.json$|LICENSE$/i

/** The rules a config asks for: the defaults (unless it turns them off) followed by its own. */
export function rulesOf(config = {}) {
  return [...(config.defaults === false ? [] : DEFAULT_RULES), ...(config.forbidden ?? [])]
}

/** Loads a config module (`export default { forbidden, allowed, defaults, binary }`). */
export async function loadConfig(path) {
  const module = await import(pathToFileURL(resolve(path)).href)
  return module.default ?? module
}

/**
 * Findings in one piece of text: `{ why, line, text }` for every rule a line matches.
 *
 * @param {string} text
 * @param {Rule[]} [rules]
 */
export function scan(text, rules = DEFAULT_RULES) {
  const found = []
  text.split(/\r?\n/).forEach((line, i) => {
    for (const { why, re } of rules) if (re.test(line)) found.push({ why, line: i + 1, text: line.trim() })
  })
  return found
}

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

/**
 * Checks one git repository.
 *
 * @param {string} repo
 * @param {{ config?: Config, history?: boolean }} [options]
 * @returns {Finding[]}
 */
export function checkRepo(repo, { config = {}, history = false } = {}) {
  const rules = rulesOf(config)
  const allowed = config.allowed ?? []
  const binary = config.binary ?? BINARY
  const isAllowed = (file, text) => allowed.some((a) => `${file}:${text}`.includes(a))
  const findings = []

  // NUL-separated: git otherwise quotes a path holding characters outside ASCII, and the quoted form names no file.
  for (const file of git(repo, ['ls-files', '-z']).split('\0').filter((f) => f && !binary.test(f))) {
    let text
    try {
      text = git(repo, ['show', `HEAD:${file}`])
    } catch {
      continue // listed but not committed yet
    }
    const lines = text.split(/\r?\n/)
    for (const f of scan(text, rules)) {
      if (!isAllowed(file, f.text) && !markedAllowed(lines, f.line - 1)) findings.push({ where: `${file}:${f.line}`, why: f.why, text: f.text })
    }
  }

  let range = ['HEAD']
  if (!history) {
    try {
      git(repo, ['rev-parse', '--verify', '--quiet', '@{upstream}'])
      range = ['@{upstream}..HEAD']
    } catch {
      // no upstream: every commit is unpushed
    }
  }
  const log = git(repo, ['log', '--format=%h%x00%B%x01', ...range])
  for (const entry of log.split('\x01')) {
    const [hash, message] = entry.trim().split('\x00')
    if (!hash) continue
    for (const f of scan(message ?? '', rules)) findings.push({ where: `@${hash}`, why: f.why, text: f.text })
  }

  if (history) findings.push(...addedLines(repo, rules, binary, isAllowed), ...tagMessages(repo, rules))
  return findings
}

/** Every line a commit reachable from any ref added, reported once, at the first commit seen. */
function addedLines(repo, rules, binary, isAllowed) {
  const findings = []
  const seen = new Set()
  const log = git(repo, ['log', '-p', '--all', '--no-color', '--no-ext-diff', '--format=\x02%h'])
  let hash = ''
  let file = ''
  let above = '' // the line before this one in the hunk, where an allow mark may be written
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith('\x02')) {
      hash = line.slice(1)
      above = ''
      continue
    }
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : ''
      above = ''
      continue
    }
    const previous = above
    above = line.startsWith('+') || line.startsWith(' ') ? line.slice(1) : ''
    if (!line.startsWith('+') || !file || binary.test(file)) continue
    if (markedAllowed([previous, line.slice(1)], 1)) continue
    for (const f of scan(line.slice(1), rules)) {
      const key = `${file}\0${f.why}\0${f.text}`
      if (seen.has(key) || isAllowed(file, f.text)) continue
      seen.add(key)
      findings.push({ where: `@${hash}:${file}`, why: `${f.why} (history)`, text: f.text })
    }
  }
  return findings
}

function tagMessages(repo, rules) {
  const findings = []
  const tags = git(repo, ['for-each-ref', 'refs/tags', '--format=%(refname:short)%00%(contents)%01'])
  for (const entry of tags.split('\x01')) {
    const [tag, message] = entry.trim().split('\x00')
    if (!tag) continue
    for (const f of scan(message ?? '', rules)) findings.push({ where: `#${tag}`, why: f.why, text: f.text })
  }
  return findings
}
