// Pin drift beyond NuGet: the npm packages a web front end declares and the crates a Tauri shell declares, judged the
// way pin-drift.js judges NuGet pins — against the newest stable version on the registry, failing on a major
// difference or more than `maxMinorGap` minor versions behind, unless a waiver with an unexpired date covers it.
//
// Which packages count is read from the registry, not from a list of names: those whose repository (the npm
// package's `repository`, the crate's `repository`) matches the caller's pattern — the packages of the app's own
// publisher, meant to be consumed at their current line. A list of name prefixes would silently leave out the next
// package nobody added to it. Every declared dependency is looked up once; a dependency the registry does not know
// (a workspace or path dependency) is passed over.

import { readFileSync } from 'node:fs'
import { judgeDrift, readWaivers } from './pin-drift.js'

/**
 * @typedef {import('./pin-drift.js').Waiver} Waiver
 * @typedef {import('./pin-drift.js').Line} Line
 * @typedef {{ name: string, version: string, repository: string | null, latest: string } | null} RegistryEntry
 */

/** A declared version as a version: `^1.2.3`, `~1.2`, `=1.2.3` → its lower bound. Null for a range that names none. */
export function declaredVersion(range) {
  const bound = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?/.exec(range.split(/\s*\|\|\s*/)[0])
  if (!bound || /^(?:file|link|workspace|git\+?|https?):/.test(range.trim())) return null
  return `${bound[1]}.${bound[2] ?? 0}.${bound[3] ?? 0}${bound[4] ?? ''}`
}

/** The dependencies a package.json declares (`dependencies`, `devDependencies`, `optionalDependencies`), as name → range. */
export function npmDeclared(manifest) {
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  return new Map(Object.entries({ ...pkg.optionalDependencies, ...pkg.devDependencies, ...pkg.dependencies }))
}

/**
 * The dependencies a Cargo.toml declares in any dependencies table — `[dependencies]`, `[dev-dependencies]`,
 * `[build-dependencies]`, a target's — written either way (`x = "1"` or `x = { version = "1", … }`), as name → version.
 * A dependency renamed with `package = "…"` counts under the crate it names; one with no version (a path or git
 * dependency) is left out.
 */
export function cargoDeclared(manifest) {
  const declared = new Map()
  let inDeps = false
  for (const line of readFileSync(manifest, 'utf8').split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (header) {
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(header[1].trim())
      continue
    }
    if (!inDeps) continue
    const plain = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(line)
    const table = /^\s*([A-Za-z0-9_-]+)\s*=\s*\{([^}]*)\}/.exec(line)
    if (plain) declared.set(plain[1], plain[2])
    else if (table) {
      const version = /\bversion\s*=\s*"([^"]+)"/.exec(table[2])?.[1]
      const renamed = /\bpackage\s*=\s*"([^"]+)"/.exec(table[2])?.[1]
      if (version) declared.set(renamed ?? table[1], version)
    }
  }
  return declared
}

const AGENT = { 'User-Agent': 'tauri-kit-dev registry-drift (https://github.com/iyulab/tauri-kit-dev)' }

/** An npm package's newest version and repository, from the registry's `latest` document; null when it has none. */
export async function npmEntry(name, fetchImpl = fetch) {
  const res = await fetchImpl(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, { headers: AGENT, signal: AbortSignal.timeout(15000) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`the npm registry answered ${res.status} for ${name}`)
  const doc = await res.json()
  const repository = typeof doc.repository === 'string' ? doc.repository : (doc.repository?.url ?? null)
  return { name, version: doc.version, repository, latest: doc.version }
}

/** A crate's newest stable version and repository, from crates.io; null when it has none. */
export async function crateEntry(name, fetchImpl = fetch) {
  const res = await fetchImpl(`https://crates.io/api/v1/crates/${name}`, { headers: AGENT, signal: AbortSignal.timeout(15000) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`crates.io answered ${res.status} for ${name}`)
  const { crate } = await res.json()
  return { name, version: crate.max_stable_version ?? crate.max_version, repository: crate.repository ?? null, latest: crate.max_stable_version ?? crate.max_version }
}

/**
 * Checks the npm packages and crates an app declares whose repository matches `repository` against their newest
 * versions.
 *
 * @param {{
 *   npm?: string, cargo?: string, repository: RegExp, maxMinorGap?: number, waivers?: Waiver[], today?: string,
 *   npmLookup?: (name: string) => Promise<RegistryEntry>, crateLookup?: (name: string) => Promise<RegistryEntry>,
 * }} options `npm` is a package.json, `cargo` a Cargo.toml; the lookups default to asking the registries.
 * @returns {Promise<{ lines: Line[], failures: number, checked: number }>}
 */
export async function checkRegistryDrift({
  npm,
  cargo,
  repository,
  maxMinorGap = 5,
  waivers: waiverList = [],
  today = new Date().toISOString().slice(0, 10),
  npmLookup = (name) => npmEntry(name),
  crateLookup = (name) => crateEntry(name),
}) {
  if (!npm && !cargo) throw new Error('nothing to check: give an npm manifest (package.json), a Cargo.toml, or both')
  const waivers = readWaivers(waiverList, today)
  /** @type {Line[]} */
  const lines = []
  let failures = 0
  let checked = 0
  const sources = [
    ...(npm ? [{ declared: npmDeclared(npm), lookup: npmLookup, label: ' (npm)' }] : []),
    ...(cargo ? [{ declared: cargoDeclared(cargo), lookup: crateLookup, label: ' (crate)' }] : []),
  ]
  for (const { declared, lookup, label } of sources) {
    for (const [name, range] of declared) {
      const version = declaredVersion(range)
      if (version === null) continue
      const entry = await lookup(name)
      if (!entry || !repository.test(entry.repository ?? '')) continue
      checked++
      const judged = judgeDrift({ id: name, version, newest: entry.latest, maxMinorGap, waivers, label })
      lines.push(...judged.lines)
      if (judged.failed) failures++
    }
  }
  for (const id of waivers.keys()) lines.push({ level: 'stale', text: `waiver for ${id} matches no tracked package — remove it` })
  if (checked === 0) throw new Error(`no declared package's repository matches ${repository} — the pattern or the manifests are wrong`)
  return { lines, failures, checked }
}
