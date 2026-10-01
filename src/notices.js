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
// packages that carry none, and `noticesText` renders a document that includes every text.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * @typedef {{ name: string, version: string, license: string, url: string, texts: string[] }} Package
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
