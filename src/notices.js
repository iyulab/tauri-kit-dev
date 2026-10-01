// Third-party notices from the dependency graphs that actually ship.
//
// A hand-written inventory of several hundred dependencies is out of date the moment anything is
// added, so the notices file is generated — and a generated file only stays accurate if something
// notices when it stops matching. This module reads what a Tauri app ships from each package
// manager's own record, screens the license expressions, and renders the tables; the app composes
// its notices file from them (which sections, in which order, with what prose and hand-kept
// prelude) and uses `writeOrCheck` both to regenerate it and, in its gate, to fail when it is stale.
//
// What each reader includes:
//   - Rust (`cargoPackages`): the normal-dependency closure of the app's binary, resolved for one
//     target. Build- and dev-dependencies run during the build and are not distributed.
//   - npm (`npmPackages`): every package in a lockfile that is not a dev dependency or a link —
//     the production closure, whose code is bundled into the web assets or a bundled helper.
//   - NuGet (`nugetPackages`): the packages of a restored .NET project (`project.assets.json`)
//     that put runtime or native assets into the build — for a bundled .NET helper. Meta-packages
//     and analyzers carry none.
//
// Every reader returns `{ name, version, license, url, texts }`, sorted by name and version.
// `texts` holds the license texts the package itself carries (LICENSE, LICENSE-MIT, COPYING, NOTICE,
// or the file a nuspec names). Most permissive licenses make keeping that text — with its copyright
// line — the condition itself, so an identifier alone does not satisfy them: `withoutText` lists the
// packages that carry none, `applyPinned` fills those in from texts pinned at the same version of
// their source, and `noticesText` renders a document that includes every text.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * @typedef {{ name: string, version: string, license: string, url: string, texts: string[], textSource?: string }} Package
 */

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/i

/**
 * The license texts a package folder carries — LICENSE, LICENSE-MIT, LICENSE.txt, COPYING, NOTICE and
 * the like — in file name order, trimmed. A missing folder carries none.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function licenseTexts(dir) {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((name) => readText(join(dir, name)))
    .filter(Boolean)
}

const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim()

/**
 * License identifiers that put no condition on the app beyond keeping the notice. An app adds the
 * ones its own license is compatible with (copyleft terms, exceptions) — that judgment is the
 * app's, so it is not made here.
 */
export const PERMISSIVE = Object.freeze([
  '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'CC0-1.0', 'ISC', 'MIT', 'MIT-0',
  'Python-2.0', 'Unicode-3.0', 'Unicode-DFS-2016', 'Zlib', 'zlib-acknowledgement', 'Unlicense',
  'WTFPL', 'CDLA-Permissive-2.0', 'OpenSSL', 'LicenseRef-Public-Domain',
])

/**
 * The identifiers an SPDX expression mentions. A slash separates too: crates older than SPDX
 * expressions still declare `MIT/Apache-2.0`, and reading that as one unknown identifier would
 * flag ordinary permissive crates by the dozen — and a screen that reports what is fine is a
 * screen nobody reads.
 *
 * @param {string} expression
 */
export function licenseIdentifiers(expression) {
  return expression
    .replace(/[()]/g, ' ')
    .split(/\s*\/\s*|\s+(?:OR|AND|WITH)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Whether any identifier in `expression` is in `accepted`. An OR gives a choice, so one is enough;
 * AND and WITH are approximated the same way on purpose — this is a screen that surfaces
 * candidates for a person to review, not a legal check.
 *
 * @param {string} expression
 * @param {Iterable<string>} accepted
 */
export function isAccepted(expression, accepted) {
  const set = accepted instanceof Set ? accepted : new Set(accepted)
  return licenseIdentifiers(expression).some((id) => set.has(id))
}

/** The packages whose license is not accepted. @param {Package[]} packages @param {Iterable<string>} accepted */
export function needsReview(packages, accepted) {
  const set = new Set(accepted)
  return packages.filter((p) => !isAccepted(p.license, set))
}

/** The packages that carry no license text of their own. @param {Package[]} packages */
export function withoutText(packages) {
  return packages.filter((p) => !p.texts?.length)
}

const byNameThenVersion = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)

/**
 * The normal-dependency closure of the Rust package at `cwd`, resolved for `target` — the package
 * itself and the other members of its workspace left out, being the app's own code.
 *
 * @param {{ cwd: string, target: string, metadata?: object }} options `metadata` is the parsed
 *   output of `cargo metadata --format-version 1 --filter-platform <target>`; without it, cargo is run.
 * @returns {Package[]}
 */
export function cargoPackages({ cwd, target, metadata }) {
  const meta =
    metadata ??
    JSON.parse(
      execFileSync('cargo', ['metadata', '--format-version', '1', '--filter-platform', target], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
      }),
    )
  const byId = new Map(meta.packages.map((p) => [p.id, p]))
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
  const reached = new Set()
  const queue = [meta.resolve.root]
  while (queue.length) {
    const id = queue.shift()
    if (reached.has(id)) continue
    reached.add(id)
    for (const dep of nodes.get(id)?.deps ?? []) {
      // `kind: null` is a normal dependency; build- and dev-dependencies are not distributed.
      if (dep.dep_kinds.some((k) => k.kind === null)) queue.push(dep.pkg)
    }
  }
  reached.delete(meta.resolve.root)
  for (const member of meta.workspace_members ?? []) reached.delete(member)
  return [...reached]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => {
      const dir = p.manifest_path ? dirname(p.manifest_path) : null
      const texts = licenseTexts(dir)
      if (!texts.length && dir && p.license_file && existsSync(join(dir, p.license_file))) texts.push(readText(join(dir, p.license_file)))
      return {
        name: p.name,
        version: p.version,
        license: p.license ?? '(not declared)',
        url: p.repository ?? `https://crates.io/crates/${p.name}`,
        texts,
      }
    })
    .sort(byNameThenVersion)
}

/**
 * The production closure recorded in an npm lockfile. The lockfile already says exactly what an
 * install resolves to, so no package manager is run.
 *
 * @param {{ lock: string, installedAt?: string | null }} options `installedAt` is where the
 *   packages are installed: their manifests fill in a license the lockfile lacks and the upstream
 *   URL it never records, and their folders the license texts. Pass `null` to read the lockfile
 *   alone — for a closure whose output must not depend on whether it happens to be installed on
 *   this machine (every URL is then the registry page, and no package carries a text).
 * @returns {Package[]}
 */
export function npmPackages({ lock, installedAt = null }) {
  const parsed = JSON.parse(readFileSync(lock, 'utf8'))
  const packages = []
  for (const [path, entry] of Object.entries(parsed.packages)) {
    if (!path || entry.dev || entry.link) continue // "" is the project itself
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    let manifest = {}
    try {
      if (installedAt) manifest = JSON.parse(readFileSync(join(installedAt, path, 'package.json'), 'utf8'))
    } catch {
      // Not installed right now: the lockfile entry still describes what ships.
    }
    const declared =
      entry.license ??
      manifest.license ??
      (Array.isArray(manifest.licenses) ? manifest.licenses.map((l) => l.type).join(' OR ') : null)
    const repo = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
    packages.push({
      name,
      version: entry.version ?? manifest.version ?? '(unknown)',
      license: typeof declared === 'string' ? declared : '(not declared)',
      url: (repo ?? `https://www.npmjs.com/package/${name}`).replace(/^git\+/, '').replace(/\.git$/, ''),
      texts: installedAt ? licenseTexts(join(installedAt, path)) : [],
    })
  }
  return packages.sort(byNameThenVersion)
}

/**
 * A license shipped as a file instead of an expression, recognised only when the file plainly says
 * what it is. Anything else stays "see <file>" and is left for review.
 *
 * @param {string} path
 */
export function licenseFromFile(path) {
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8').trim()
  if (/^MIT License\b/.test(text)) return 'MIT'
  if (/\bis Public Domain\b/i.test(text.slice(0, 200))) return 'LicenseRef-Public-Domain'
  return null
}

const hasFiles = (assets) => !!assets && Object.keys(assets).some((f) => !f.endsWith('_._'))

/**
 * The NuGet packages of a restored project that put runtime or native assets into its build.
 * Licenses come from each package's own nuspec in the restore's package folder.
 *
 * @param {{ assets: string }} options the project's `obj/project.assets.json` — present only after
 *   `dotnet restore`
 * @returns {Package[]}
 */
export function nugetPackages({ assets }) {
  if (!existsSync(assets)) throw new Error(`${assets} is missing — run \`dotnet restore\` first`)
  const parsed = JSON.parse(readFileSync(assets, 'utf8'))
  const folder = Object.keys(parsed.packageFolders ?? {})[0]
  const packages = []
  for (const target of Object.values(parsed.targets)) {
    for (const [key, lib] of Object.entries(target)) {
      if (lib.type !== 'package') continue
      if (!hasFiles(lib.runtime) && !hasFiles(lib.native) && !hasFiles(lib.runtimeTargets)) continue
      const [name, version] = key.split('/')
      const id = name.toLowerCase()
      const dir = join(folder, id, version.toLowerCase())
      const nuspecPath = join(dir, `${id}.nuspec`)
      const nuspec = existsSync(nuspecPath) ? readFileSync(nuspecPath, 'utf8') : ''
      const expression = nuspec.match(/<license\s+type="expression"\s*>([^<]+)<\/license>/)?.[1]?.trim()
      const licenseFile = nuspec.match(/<license\s+type="file"\s*>([^<]+)<\/license>/)?.[1]?.trim()
      const licenseUrl = nuspec.match(/<licenseUrl>([^<]+)<\/licenseUrl>/)?.[1]?.trim()
      const repo =
        nuspec.match(/<repository\b[^>]*\burl="([^"]+)"/)?.[1] ?? nuspec.match(/<projectUrl>([^<]+)<\/projectUrl>/)?.[1]
      packages.push({
        name,
        version,
        license:
          expression ??
          (licenseFile
            ? (licenseFromFile(join(dir, licenseFile)) ?? `see ${licenseFile} in the package`)
            : licenseUrl
              ? `see ${licenseUrl}`
              : '(not declared)'),
        url: (repo ?? `https://www.nuget.org/packages/${name}`).replace(/\.git$/, ''),
        texts: licenseFile && existsSync(join(dir, licenseFile)) ? [readText(join(dir, licenseFile))] : licenseTexts(dir),
      })
    }
  }
  const unique = new Map(packages.map((p) => [`${p.name}@${p.version}`, p]))
  return [...unique.values()].sort(byNameThenVersion)
}

/** A Markdown table of packages. @param {Package[]} packages */
export function noticesTable(packages) {
  const rows = packages.map((p) => `| \`${p.name}\` | ${p.version} | ${p.license} | ${p.url} |`)
  return ['| Component | Version | License | Upstream |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

/**
 * A plain-text notices document: a heading, then each package with its license, upstream and the
 * license texts it carries. A text that several packages carry word for word is printed once, at
 * its first package, and referred to from the others — each text is still kept whole, copyright
 * lines included, which grouping packages under one license name would lose.
 *
 * @param {Package[]} packages
 * @param {{ title?: string }} [options]
 */
export function noticesText(packages, { title = 'Third-party notices' } = {}) {
  const rule = '-'.repeat(78)
  const count = new Map()
  for (const p of packages) for (const t of p.texts ?? []) count.set(t, (count.get(t) ?? 0) + 1)
  const firstAt = new Map()
  const out = [title, '='.repeat(title.length), '', `This program includes the following ${packages.length} third-party packages.`, '']
  for (const p of packages) {
    out.push(rule, `${p.name} ${p.version}`, `License: ${p.license}`, `Upstream: ${p.url}`)
    if (p.textSource) out.push(`License text from: ${p.textSource}`)
    for (const t of p.texts ?? []) {
      if (firstAt.has(t)) {
        out.push('', `Same license text as ${firstAt.get(t)}.`)
        continue
      }
      if (count.get(t) > 1) firstAt.set(t, `${p.name} ${p.version}`)
      out.push('', t)
    }
    out.push('')
  }
  return out.join('\n')
}

// Pinned license texts — for a package that ships without its license text.
//
// Plenty of packages declare a license but leave its text out of what they publish. The text then
// has to come from the package's source at that same version, and it has to stay that text: a pin
// names the exact file (a URL that fixes the version — a tag or a commit, not a branch) and its
// SHA-256, and the text itself is committed next to the pins. Generating notices reads only those
// committed files and checks every digest, so the output never depends on the network and a check
// in CI gives the same answer as on a laptop. Fetching is a separate, deliberate step
// (`fetchPinned`), the way a lockfile is written by an install and only read by a build.
//
// A pin is keyed by `name@version`. When a package moves to another version its pin no longer
// applies, the package is without text again, and a gate on `withoutText` stops until the new
// version is pinned — on purpose, since the text can change between versions. A pin may list
// several files, for a license whose conditions span more than one: Apache-2.0 asks for the NOTICE
// file along with the license, and a package that includes code under another license has that
// license's text too.

/**
 * @typedef {{ source: string, sha256?: string }} PinnedFile
 * @typedef {PinnedFile | PinnedFile[]} Pin
 */

const pinFiles = (pin) => (Array.isArray(pin) ? pin : [pin])
const pinPath = (dir, key, index, count) =>
  join(dir, `${key.replace(/[\\/:*?"<>|]/g, '_')}${count > 1 ? `.${index + 1}` : ''}.txt`)
// The digest is of the text with CRLF read as LF, so a checkout that converts line endings (git's
// autocrlf on Windows) still matches the pin.
const digest = (bytes) => createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex')

/** @param {string | Record<string, Pin>} pins a pins JSON file, or its contents */
const pinTable = (pins) => (typeof pins === 'string' ? (existsSync(pins) ? JSON.parse(readFileSync(pins, 'utf8')) : {}) : pins)

/**
 * Fills in the texts of packages that carry none from pinned, committed files.
 *
 * Returns the packages (a filled one also gets `textSource`, the pinned URLs), the pins that
 * applied to nothing (`unused` — a package moved to another version, left the graph, or now
 * carries its own text), and the pins that could not be applied (`problems` — a file is missing,
 * or its digest is not the pinned one). A package with a problem keeps no text, so `withoutText`
 * still lists it.
 *
 * @param {Package[]} packages
 * @param {{ pins: string | Record<string, Pin>, dir: string }} options `dir` holds one file per
 *   pinned file
 * @returns {{ packages: Package[], unused: string[], problems: { key: string, problem: string }[] }}
 */
export function applyPinned(packages, { pins, dir }) {
  const table = pinTable(pins)
  const applied = new Set()
  const problems = []
  const filled = packages.map((p) => {
    const key = `${p.name}@${p.version}`
    if (!table[key] || p.texts?.length) return p
    const files = pinFiles(table[key])
    const texts = []
    for (const [i, pinned] of files.entries()) {
      const file = pinPath(dir, key, i, files.length)
      if (!existsSync(file)) {
        problems.push({ key, problem: `${file} is missing — fetch the pinned texts` })
        return p
      }
      const bytes = readFileSync(file)
      if (!pinned.sha256 || digest(bytes) !== pinned.sha256) {
        problems.push({ key, problem: pinned.sha256 ? `${file} is not the pinned text (SHA-256 differs)` : `${pinned.source} has no SHA-256 — fetch the pinned texts` })
        return p
      }
      texts.push(bytes.toString('utf8').replace(/\r\n/g, '\n').trim())
    }
    applied.add(key)
    return { ...p, texts, textSource: files.map((f) => f.source).join(', ') }
  })
  const unused = Object.keys(table).filter((key) => !applied.has(key) && !problems.some((x) => x.key === key))
  return { packages: filled, unused, problems }
}

/**
 * Downloads the pinned texts into `dir`. A pinned file without a SHA-256 is fetched and gets one —
 * written back when `pins` is a file — so pinning starts with `{ source }` alone and the digest
 * records what was seen then. A file with a SHA-256 is fetched only when it is missing or differs,
 * and a download that does not match the pinned digest is an error: the source changed under the pin.
 *
 * @param {{ pins: string | Record<string, Pin>, dir: string, fetch?: typeof globalThis.fetch }} options
 * @returns {Promise<{ fetched: string[], pinned: string[] }>} the URLs fetched, and those that got a digest
 */
export async function fetchPinned({ pins, dir, fetch = globalThis.fetch }) {
  const table = pinTable(pins)
  mkdirSync(dir, { recursive: true })
  const fetched = []
  const pinned = []
  try {
    for (const [key, pin] of Object.entries(table)) {
      const files = pinFiles(pin)
      for (const [i, entry] of files.entries()) {
        const file = pinPath(dir, key, i, files.length)
        if (entry.sha256 && existsSync(file) && digest(readFileSync(file)) === entry.sha256) continue
        const response = await fetch(entry.source)
        if (!response.ok) throw new Error(`${key}: ${entry.source} answered ${response.status}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        const got = digest(bytes)
        if (entry.sha256 && got !== entry.sha256) throw new Error(`${key}: ${entry.source} is not the pinned text (SHA-256 ${got}, pinned ${entry.sha256})`)
        if (!entry.sha256) {
          entry.sha256 = got
          pinned.push(entry.source)
        }
        writeFileSync(file, bytes)
        fetched.push(entry.source)
      }
    }
  } finally {
    // The texts fetched before a failure keep their digests.
    if (pinned.length && typeof pins === 'string') writeFileSync(pins, `${JSON.stringify(table, null, 2)}\n`)
  }
  return { fetched, pinned }
}

/**
 * Writes `body` to `file`, or with `check` compares instead and writes nothing. Returns whether the
 * file now matches — with `check`, `false` means the committed file is stale.
 *
 * @param {string} file
 * @param {string} body
 * @param {{ check?: boolean }} [options]
 */
export function writeOrCheck(file, body, { check = false } = {}) {
  if (check) return existsSync(file) && readFileSync(file, 'utf8') === body
  writeFileSync(file, body, 'utf8')
  return true
}
