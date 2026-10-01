// Checks a Tauri app's NSIS installer the way a person gets the app: installed silently for the
// current user (no administrator) into a temporary folder, started, installed over a published
// version, uninstalled. Windows only; the decisions are plain functions any platform can test.
//
// The installed window cannot be driven over a debugging port when the app passes WebView2 its own
// browser arguments (they take the place of WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS), so what these
// checks show is that an installed copy installs, starts, stays up, updates and uninstalls — and
// whatever the app checks itself inside `withInstalled`.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** NSIS arguments for a silent install into `target`: /S is silent, /D= must come last and unquoted. */
export function nsisArgs(target) {
  return ['/S', `/D=${target}`]
}

/**
 * The installer for `version` among the files of a bundle folder — installers of earlier versions
 * may still sit beside it.
 *
 * @param {string[]} files
 * @param {{ version: string, suffix?: string }} options  suffix: what follows `_<version>` (default `_x64-setup.exe`)
 */
export function pickInstaller(files, { version, suffix = '_x64-setup.exe' }) {
  const found = files.filter((f) => f.endsWith(`_${version}${suffix}`))
  return found.length === 1 ? found[0] : undefined
}

/** The installer for `version` in `dir`, or an error that says how to get one. */
export function findInstaller(dir, { version, suffix, hint = 'build the installer first' }) {
  const found = pickInstaller(existsSync(dir) ? readdirSync(dir) : [], { version, suffix })
  if (!found) throw new Error(`expected the ${version} installer in ${dir} — ${hint}`)
  return join(dir, found)
}

/**
 * The published version to update from: the one asked for, or the newest published release that
 * is not the version being checked.
 *
 * @param {{ tagName: string, publishedAt: string }[]} releases  published (not draft) releases
 * @param {string} version  the version being checked, without a leading `v`
 * @param {string} [asked]  a tag to use instead
 */
export function pickUpgradeFrom(releases, version, asked) {
  if (asked) return asked
  return [...releases].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map((r) => r.tagName).find((tag) => tag !== `v${version}` && tag !== version)
}

/** Runs a program to completion, without a console, and fails unless it exits 0. */
export function run(exe, args, what = `${exe} ${args.join(' ')}`) {
  const result = spawnSync(exe, args, { stdio: 'ignore', windowsVerbatimArguments: true })
  if (result.status !== 0) throw new Error(`${what}: exited with ${result.status}${result.error ? ` (${result.error.message})` : ''}`)
}

/** Runs `gh` and answers what it printed. */
export function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')}: ${(result.stderr ?? result.error?.message ?? '').trim()}`)
  return result.stdout.trim()
}

/** The product version an executable reports in its file properties. */
export function fileVersion(exe) {
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe.replaceAll("'", "''")}').VersionInfo.ProductVersion`], { encoding: 'utf8' })
  return ps.stdout.trim()
}

/**
 * Starts `exe`, waits `holdMs`, and answers whether it was still running; then ends it.
 *
 * @param {string} exe
 * @param {{ env?: NodeJS.ProcessEnv, holdMs?: number }} [options]
 */
export async function startsAndStays(exe, { env = process.env, holdMs = 8000 } = {}) {
  const child = spawn(exe, [], { stdio: 'ignore', env })
  await sleep(holdMs)
  const running = child.exitCode === null && child.signalCode === null
  child.kill()
  await new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done)))
  return running
}

/** Uninstalls what NSIS put in `target`, and waits until `exe` is gone (the uninstaller finishes in the background). */
export async function uninstall(target, { exe, timeoutMs = 10_000 } = {}) {
  const uninstaller = join(target, 'uninstall.exe')
  if (!existsSync(uninstaller)) return false
  run(uninstaller, ['/S'], 'uninstalling')
  if (exe) {
    const until = Date.now() + timeoutMs
    while (existsSync(join(target, exe)) && Date.now() < until) await sleep(250)
    if (existsSync(join(target, exe))) throw new Error(`${exe} is still in ${target} after uninstalling`)
  }
  return true
}

/**
 * Installs into a fresh temporary folder, runs `body` with that folder, then uninstalls and removes
 * the folder — whether `body` passed or not.
 *
 * @template T
 * @param {string} installer
 * @param {(target: string) => Promise<T>} body
 * @param {{ exe?: string, prefix?: string }} [options]  exe: the app's file name, checked to be gone after uninstalling
 */
export async function withInstalled(installer, body, { exe, prefix = 'tauri-app-installed-' } = {}) {
  const temp = await mkdtemp(join(tmpdir(), prefix))
  const target = join(temp, 'app')
  try {
    run(installer, nsisArgs(target), 'installing')
    if (exe && !(await readdir(target)).some((f) => f.toLowerCase() === exe.toLowerCase())) {
      throw new Error(`${exe} is not in ${target} after installing`)
    }
    return await body(target)
  } finally {
    await uninstall(target, { exe }).finally(() => rm(temp, { recursive: true, force: true }))
  }
}

/** Downloads the published installer of `tag` into `dir` and answers its path. */
export async function downloadInstaller({ repo, tag, dir, pattern = '*_x64-setup.exe' }) {
  gh(['release', 'download', tag, '-R', repo, '--pattern', pattern, '--dir', dir])
  const suffix = pattern.replace(/^\*/, '')
  const found = (await readdir(dir)).filter((f) => f.endsWith(suffix))
  if (found.length !== 1) throw new Error(`release ${tag} of ${repo} has no single ${pattern}`)
  return join(dir, found[0])
}

/** The published releases of `repo` (drafts left out), in no particular order. */
export function publishedReleases(repo) {
  return JSON.parse(gh(['release', 'list', '-R', repo, '--exclude-drafts', '--json', 'tagName,publishedAt']))
}

/**
 * Where WebView2 keeps the copies of a profile it takes when the runtime updates itself. A copy
 * taken before an app turned autofill off still carries the form entries typed into it.
 *
 * @param {string} appData  the app's local data folder (`%LOCALAPPDATA%\<identifier>`)
 */
export function profileSnapshots(appData) {
  return join(appData, 'EBWebView', 'Snapshots')
}

/** Leaves a profile copy the way a runtime update would, so a check can see the app remove it. */
export async function seedProfileSnapshot(appData) {
  const dir = join(profileSnapshots(appData), '1.0.0.0', 'Default')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Web Data'), 'an entry typed into an earlier version')
}
