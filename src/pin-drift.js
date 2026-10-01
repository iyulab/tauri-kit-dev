// Pin drift for packages an app is meant to keep current with — NuGet, for a bundled .NET helper.
//
// Some dependencies are meant to be consumed at their current line: packages from the app's own
// publisher, released often alongside it. Falling behind them is silent — restore, build and tests
// stay green on an old pin — so the gap grows until an upgrade becomes a migration. This compares
// each such pin in a central package file (`Directory.Packages.props`) with the newest version on
// nuget.org and fails when the major version differs (always a person's decision) or the pin is more
// than `maxMinorGap` minor versions behind — unless a waiver with an expiry that has not passed
// covers it. A waiver without an expiry is refused: it would be a permanent suppression under
// another name; one no longer needed is reported, so it is removed rather than left to hide the
// next drift. Smaller gaps are reported and pass — drift alone is not a defect, drift nobody sees is.
//
// Which packages count is read from the restored graph (`project.assets.json`, so `dotnet restore`
// has to have run): those whose own nuspec lists `publisher` among its authors — not a list of
// name prefixes, which silently leaves out the next package nobody added to it. Also:
//   - such packages that arrive only transitively are held to the same threshold: nothing pins
//     them, so nothing else would notice them falling behind;
//   - a pinned package whose own declared floor on another such package lags far behind is noted
//     (not failed) — a sign it is no longer kept up with, which only its maintainers can change.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @typedef {{ package: string, until: string, reason: string }} Waiver
 * @typedef {{ level: 'ok' | 'stale' | 'waived' | 'FAIL' | 'note', text: string }} Line
 * @typedef {{ lines: Line[], failures: number, pinned: number, transitive: number }} DriftReport
 */

/** @param {string} v */
export function parseVersion(v) {
  const [core, pre] = v.split('-', 2)
  const [major, minor, patch] = core.split('.').map((n) => Number.parseInt(n, 10))
  return { major, minor: minor ?? 0, patch: patch ?? 0, pre: pre ?? null, raw: v }
}

/** Every package the restore resolved, as id → version. @param {object} assets */
export function resolvedPackages(assets) {
  const resolved = new Map()
  for (const target of Object.values(assets.targets ?? {})) {
    for (const [key, entry] of Object.entries(target)) {
      if (entry.type !== 'package') continue
      const [id, version] = key.split('/')
      resolved.set(id, version)
    }
  }
  return resolved
}

/** Whether a restored package lists `publisher` among its nuspec authors. */
export function isPublishedBy(assets, id, version, publisher) {
  const library = assets.libraries?.[`${id}/${version}`]
  if (!library?.path) return false
  for (const folder of Object.keys(assets.packageFolders ?? {})) {
    const nuspec = join(folder, library.path, `${id.toLowerCase()}.nuspec`)
    if (!existsSync(nuspec)) continue
    const authors = /<authors>([^<]*)<\/authors>/.exec(readFileSync(nuspec, 'utf8'))?.[1] ?? ''
    return authors.split(',').some((a) => a.trim().toLowerCase() === publisher.toLowerCase())
  }
  throw new Error(`the restored nuspec of ${id} ${version} was not found — run \`dotnet restore\``)
}

/**
 * The waivers by package, each marked expired or not. Every waiver needs `package`, `until`
 * (YYYY-MM-DD) and `reason`.
 *
 * @param {Waiver[]} list
 * @param {string} today YYYY-MM-DD
 */
export function readWaivers(list, today) {
  const byId = new Map()
  for (const w of list) {
    if (!w.package || !w.until || !w.reason) {
      throw new Error(`every waiver needs package, until and reason — got ${JSON.stringify(w)}`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.until)) {
      throw new Error(`"until" must be YYYY-MM-DD — got "${w.until}" for ${w.package}`)
    }
    byId.set(w.package, { ...w, expired: w.until < today })
  }
  return byId
}

/** The newest version of `id` on nuget.org — stable only unless `allowPrerelease`. */
export async function nugetLatest(id, allowPrerelease, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.nuget.org/v3-flatcontainer/${id.toLowerCase()}/index.json`, {
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`nuget.org answered ${res.status} for ${id}`)
  const { versions } = await res.json()
  const candidates = versions.filter((v) => allowPrerelease || !v.includes('-'))
  if (candidates.length === 0) throw new Error(`nuget.org lists no ${allowPrerelease ? '' : 'stable '}version of ${id}`)
  return candidates[candidates.length - 1]
}

/** The lower bound a published package's nuspec declares on each dependency, as id → version. */
export async function nugetFloors(id, version, fetchImpl = fetch) {
  const lower = id.toLowerCase()
  const url = `https://api.nuget.org/v3-flatcontainer/${lower}/${version.toLowerCase()}/${lower}.nuspec`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`nuget.org answered ${res.status} for the ${id} ${version} nuspec`)
  const floors = new Map()
  for (const m of (await res.text()).matchAll(/<dependency\s+id="([^"]+)"\s+version="([^"]+)"/g)) {
    const bound = m[2].replace(/^[[(]/, '').split(',')[0].trim()
    if (bound) floors.set(m[1], bound)
  }
  return floors
}

/**
 * Checks the pins of `publisher`'s packages in `props` against the newest versions.
 *
 * @param {{
 *   props: string, assets: string, publisher: string, maxMinorGap?: number,
 *   waivers?: Waiver[], today?: string,
 *   latest?: (id: string, allowPrerelease: boolean) => Promise<string>,
 *   floors?: (id: string, version: string) => Promise<Map<string, string>>,
 * }} options `latest` and `floors` default to asking nuget.org.
 * @returns {Promise<DriftReport>}
 */
export async function checkPinDrift({
  props,
  assets: assetsPath,
  publisher,
  maxMinorGap = 5,
  waivers: waiverList = [],
  today = new Date().toISOString().slice(0, 10),
  latest = (id, pre) => nugetLatest(id, pre),
  floors = (id, version) => nugetFloors(id, version),
}) {
  if (!existsSync(assetsPath)) throw new Error(`${assetsPath} not found — run \`dotnet restore\` first`)
  const assets = JSON.parse(readFileSync(assetsPath, 'utf8'))
  const waivers = readWaivers(waiverList, today)
  const resolved = resolvedPackages(assets)
  const ours = (id, version) =>
    assets.libraries?.[`${id}/${version}`] ? isPublishedBy(assets, id, version, publisher) : false

  const pins = []
  for (const m of readFileSync(props, 'utf8').matchAll(/<PackageVersion\s+Include="([^"]+)"\s+Version="([^"]+)"/g)) {
    // A pin the restore did not resolve (a test-only package outside the restored project) is
    // judged by its own nuspec on disk only when it is there.
    if (ours(m[1], resolved.get(m[1]) ?? m[2])) pins.push({ id: m[1], version: m[2] })
  }
  if (pins.length === 0) {
    throw new Error(`no pins of ${publisher} packages found in ${props} — the file moved, or the restore graph is empty`)
  }

  const cache = new Map()
  const latestOf = async (id, pre) => {
    const key = `${id}|${pre}`
    if (!cache.has(key)) cache.set(key, await latest(id, pre))
    return cache.get(key)
  }

  /** @type {Line[]} */
  const lines = []
  const say = (level, text) => lines.push({ level, text })

  const judge = async (id, version, kind) => {
    const have = parseVersion(version)
    const newest = parseVersion(await latestOf(id, have.pre !== null))
    const majorDiff = newest.major !== have.major
    const minorGap = majorDiff ? Infinity : newest.minor - have.minor
    const over = majorDiff || minorGap > maxMinorGap
    const waiver = waivers.get(id)
    waivers.delete(id)
    const gap = majorDiff ? 'major version differs' : `${minorGap} minor behind`
    const label = kind === 'transitive' ? ' (transitive)' : ''
    if (!over) {
      say('ok', `${id} ${have.raw}${label} (latest ${newest.raw}, ${newest.raw === have.raw ? 'current' : gap})`)
      if (waiver) say('stale', `waiver for ${id} is no longer needed — remove it`)
      return false
    }
    if (waiver && !waiver.expired) {
      say('waived', `${id} ${have.raw}${label} (latest ${newest.raw}, ${gap}) until ${waiver.until}: ${waiver.reason}`)
      return false
    }
    const why = waiver ? `waiver expired on ${waiver.until}` : 'no waiver'
    const fix = kind === 'transitive' ? ' — move the pinned package that brings it in' : ''
    say('FAIL', `${id} ${have.raw}${label} (latest ${newest.raw}, ${gap}; ${why})${fix}`)
    return true
  }

  let failures = 0
  for (const pin of pins) if (await judge(pin.id, pin.version, 'pinned')) failures++
  const pinnedIds = new Set(pins.map((p) => p.id))
  const transitive = [...resolved].filter(([id, version]) => !pinnedIds.has(id) && ours(id, version))
  for (const [id, version] of transitive) if (await judge(id, version, 'transitive')) failures++

  // Noted, never failed: a stale floor is the package's own maintainers' to move.
  for (const pin of pins) {
    for (const [dep, floor] of await floors(pin.id, pin.version)) {
      const depVersion = resolved.get(dep)
      if (!depVersion || !ours(dep, depVersion)) continue
      const have = parseVersion(floor)
      const newest = parseVersion(await latestOf(dep, have.pre !== null))
      const gap = newest.major !== have.major ? Infinity : newest.minor - have.minor
      if (gap > maxMinorGap) {
        const said = gap === Infinity ? 'a major version' : `${gap} minor versions`
        say('note', `${pin.id} ${pin.version} still declares ${dep} >= ${floor}, ${said} behind ${newest.raw} — is it still kept up with?`)
      }
    }
  }
  for (const id of waivers.keys()) say('stale', `waiver for ${id} matches no tracked package — remove it`)

  return { lines, failures, pinned: pins.length, transitive: transitive.length }
}

/** A report line as printed. @param {Line} line */
export const formatLine = ({ level, text }) => `  ${level.padEnd(8)}${text}`
