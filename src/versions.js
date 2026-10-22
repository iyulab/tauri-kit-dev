// The version an app writes in more than one file — its shell's Cargo.toml and the lock entry for it, tauri.conf.json,
// package.json and its lock, a .NET helper's project — checked to agree, and moved together.
//
// A release that bumps one of them and forgets another ships an installer whose About box, update feed or crash
// reports disagree about what it is; nothing fails until someone compares them by hand. Which files hold the version
// is the app's to say (a config listing them); how each kind of file holds it is this module's:
//   - `Cargo.toml`: `version` in `[package]`, or in `[workspace.package]` when the manifest is a workspace's;
//   - `Cargo.lock`: the `version` of the `[[package]]` named `package` (the entry needs it — a lock holds every crate);
//   - a JSON file (`tauri.conf.json`, `package.json`): its top-level `version`;
//   - `package-lock.json`: its top-level `version` and that of the root package (`packages[""]`);
//   - a .NET project or props file (`.csproj`, `.props`): its first `<Version>`.
// Each is rewritten in place, its other text untouched.

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

/**
 * @typedef {string | { file: string, package?: string }} VersionFile
 * @typedef {{ file: string, version: string | null, problem?: string }} FoundVersion
 */

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Whether `version` is one a release can carry: `major.minor.patch`, with a prerelease or build part if any. */
export function isVersion(version) {
  return SEMVER.test(version)
}

/** @param {VersionFile} entry */
function entryOf(entry) {
  return typeof entry === 'string' ? { file: entry } : entry
}

/** How a file holds its version, from its name. */
function kindOf(file) {
  const name = basename(file).toLowerCase()
  if (name === 'cargo.toml') return 'cargo-toml'
  if (name === 'cargo.lock') return 'cargo-lock'
  if (name === 'package-lock.json') return 'npm-lock'
  if (extname(name) === '.json') return 'json'
  if (['.csproj', '.fsproj', '.vbproj', '.props'].includes(extname(name))) return 'msbuild'
  throw new Error(`${file}: not a file whose version this knows how to read (Cargo.toml, Cargo.lock, *.json, package-lock.json, *.csproj, *.props)`)
}

/**
 * Where the version sits in a TOML manifest's `table`: the span of its value, between the quotes. Null when the
 * table, or a `version` in it, is not there.
 */
function tomlSpan(text, table) {
  const header = new RegExp(`^\\[${table.replace('.', '\\.')}\\][ \\t]*(?:#.*)?$`, 'm').exec(text)
  if (!header) return null
  const start = header.index + header[0].length
  const next = /^\[/m.exec(text.slice(start))
  const body = text.slice(start, next ? start + next.index : text.length)
  const line = /^[ \t]*version[ \t]*=[ \t]*"([^"]*)"/m.exec(body)
  if (!line) return null
  const at = start + line.index + line[0].lastIndexOf(line[1])
  return { from: at, to: at + line[1].length }
}

/** The span of the version of the `[[package]]` named `name` in a Cargo lock. */
function lockSpan(text, name) {
  const entries = text.split(/^(?=\[\[package\]\])/m)
  let offset = 0
  for (const entry of entries) {
    if (new RegExp(`^name = "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm').test(entry)) {
      const line = /^version = "([^"]*)"$/m.exec(entry)
      if (!line) return null
      const at = offset + line.index + line[0].indexOf('"') + 1
      return { from: at, to: at + line[1].length }
    }
    offset += entry.length
  }
  return null
}

/**
 * The spans of a JSON document's top-level `version` — and, for an npm lock, its root package's — found by walking
 * the text so the rest of it is left exactly as written.
 */
function jsonSpans(text, lock) {
  const spans = []
  // The depth each `"version"` key appears at, and under which key the object holding it sits.
  let depth = 0
  const path = []
  let pendingKey = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const value = JSON.parse(text.slice(i, j + 1))
      const after = /^\s*:/.exec(text.slice(j + 1))
      if (after) {
        pendingKey = value
        i = j + after[0].length
        // A string value right after the key.
        const rest = /^\s*"/.exec(text.slice(i + 1))
        if (rest && value === 'version') {
          const from = i + 1 + rest[0].length
          let k = from
          while (k < text.length && text[k] !== '"') k += text[k] === '\\' ? 2 : 1
          const top = depth === 1
          const root = lock && depth === 3 && path[1] === 'packages' && path[2] === ''
          if (top || root) spans.push({ from, to: k })
        }
      } else {
        i = j
      }
      continue
    }
    if (c === '{' || c === '[') {
      depth++
      path[depth - 1] = pendingKey
      pendingKey = null
    } else if (c === '}' || c === ']') {
      depth--
    }
  }
  return spans
}

/** The spans of a file's version, by its kind. @param {{ file: string, package?: string }} entry */
function spansOf(text, entry) {
  switch (kindOf(entry.file)) {
    case 'cargo-toml': {
      const span = tomlSpan(text, 'package') ?? tomlSpan(text, 'workspace.package')
      return span ? [span] : []
    }
    case 'cargo-lock': {
      if (!entry.package) throw new Error(`${entry.file}: a Cargo lock needs { package } — the crate whose entry holds the version`)
      const span = lockSpan(text, entry.package)
      return span ? [span] : []
    }
    case 'json':
      return jsonSpans(text, false).slice(0, 1)
    case 'npm-lock':
      return jsonSpans(text, true)
    case 'msbuild': {
      const tag = /<Version>([^<]*)<\/Version>/.exec(text)
      if (!tag) return []
      const from = tag.index + '<Version>'.length
      return [{ from, to: from + tag[1].length }]
    }
  }
}

/**
 * The version each file holds, and whether they agree. A file without one, or one whose places disagree within it
 * (an npm lock's two), is reported with a problem and counts as not agreeing.
 * @param {VersionFile[]} files @param {(file: string) => string} [resolvePath]
 * @returns {{ found: FoundVersion[], agree: boolean, version: string | null }}
 */
export function checkVersions(files, resolvePath = (f) => f) {
  const found = files.map(entryOf).map((entry) => {
    const text = readFileSync(resolvePath(entry.file), 'utf8')
    const values = [...new Set(spansOf(text, entry).map((s) => text.slice(s.from, s.to)))]
    if (values.length === 0) return { file: entry.file, version: null, problem: 'no version found' }
    if (values.length > 1) return { file: entry.file, version: null, problem: `versions within it disagree: ${values.join(', ')}` }
    return { file: entry.file, version: values[0] }
  })
  const versions = new Set(found.map((f) => f.version))
  const agree = found.every((f) => f.version !== null) && versions.size === 1
  return { found, agree, version: agree ? found[0].version : null }
}

/**
 * Writes `version` into every file, each in place. Every file is read and its places found before any is written, so
 * a file whose version cannot be found leaves them all as they were.
 * @param {VersionFile[]} files @param {string} version @param {(file: string) => string} [resolvePath]
 */
export function bumpVersions(files, version, resolvePath = (f) => f) {
  if (!isVersion(version)) throw new Error(`"${version}" is not a version (major.minor.patch)`)
  // A file named by several entries — a Cargo lock holding several of the repository's crates — is written once,
  // with every entry's places: written entry by entry, the last write would undo the others.
  const planned = new Map()
  for (const entry of files.map(entryOf)) {
    const path = resolvePath(entry.file)
    const plan = planned.get(path) ?? { path, text: readFileSync(path, 'utf8'), spans: [] }
    const spans = spansOf(plan.text, entry)
    if (spans.length === 0) throw new Error(`${entry.file}: no version found — nothing written`)
    plan.spans.push(...spans)
    planned.set(path, plan)
  }
  for (const { path, text, spans } of planned.values()) {
    let written = text
    for (const span of [...spans].sort((a, b) => b.from - a.from)) written = written.slice(0, span.from) + version + written.slice(span.to)
    writeFileSync(path, written)
  }
}
