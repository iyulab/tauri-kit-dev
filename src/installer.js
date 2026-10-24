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
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
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
  // Verbatim, since NSIS takes `/D=` unquoted even with spaces; the program's own path is quoted, or
  // a space ends it and NSIS reads the rest as options — `…/rt/…` as `/R`, run the app after installing.
  const result = spawnSync(exe, args, { stdio: 'ignore', windowsVerbatimArguments: true, argv0: `"${exe}"` })
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
 * the folder — whether `body` passed or not. An NSIS installer keeps the folder it installed into as
 * the default value of `HKCU\Software\<maker>\<product>`, and its uninstaller leaves it there, so
 * the next plain install of the product would go into the removed temporary folder: on Windows that
 * value is put back as it was before (`installLocationRestores`).
 *
 * @template T
 * @param {string} installer
 * @param {(target: string) => Promise<T>} body
 * @param {{ exe?: string, prefix?: string }} [options]  exe: the app's file name, checked to be gone after uninstalling
 */
export async function withInstalled(installer, body, { exe, prefix = 'tauri-app-installed-' } = {}) {
  // The folder's long form: a temporary folder can come in its short one (RUNNER~1 on CI runners),
  // which compares unequal to the paths the installed processes report.
  const temp = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const target = join(temp, 'app')
  const before = process.platform === 'win32' ? softwareKeys() : null
  try {
    run(installer, nsisArgs(target), 'installing')
    if (exe && !(await readdir(target)).some((f) => f.toLowerCase() === exe.toLowerCase())) {
      throw new Error(`${exe} is not in ${target} after installing`)
    }
    return await body(target)
  } finally {
    await uninstall(target, { exe })
      .finally(() => before && restoreInstallLocation(before, target))
      .finally(() => rm(temp, { recursive: true, force: true }))
  }
}

/**
 * The keys one and two levels under `HKCU\Software` with their default value, as `powershell`
 * lists them: one line per key, `path<TAB>1<TAB>value` for a key with a default value and
 * `path<TAB>0<TAB>` for one without. Keyed by the path in lower case.
 *
 * @param {string} text
 * @returns {Map<string, { path: string, value: string | null }>}
 */
export function parseSoftwareKeys(text) {
  const keys = new Map()
  for (const line of text.split(/\r?\n/)) {
    const [path, has, ...rest] = line.split('\t')
    if (!path || (has !== '0' && has !== '1')) continue
    keys.set(path.toLowerCase(), { path, value: has === '1' ? rest.join('\t') : null })
  }
  return keys
}

/** Every key one and two levels under `HKCU\Software`, with its default value (`parseSoftwareKeys`). Windows only. */
export function softwareKeys() {
  const command = [
    "Get-ChildItem HKCU:\\Software -ErrorAction SilentlyContinue",
    "ForEach-Object { $_; Get-ChildItem $_.PSPath -ErrorAction SilentlyContinue }",
    "ForEach-Object { $v = $_.GetValue(''); $p = $_.Name.Substring('HKEY_CURRENT_USER\\'.Length); if ($null -eq $v) { \"$p`t0`t\" } else { \"$p`t1`t$v\" } }",
  ].join(' | ')
  return parseSoftwareKeys(powershell(command))
}

const sameFolder = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/**
 * What to put back after installing into `target`: each key whose default value the install set to
 * `target`, with how to leave it as it was in `before` — `set` it to the value it held, `clear` the
 * default value of a key that had none, or `remove` a key that was not there.
 *
 * @param {Map<string, { path: string, value: string | null }>} before
 * @param {Map<string, { path: string, value: string | null }>} after
 * @param {string} target
 * @returns {{ path: string, action: 'set' | 'clear' | 'remove', value?: string }[]}
 */
export function installLocationRestores(before, after, target) {
  const restores = []
  for (const [key, { path, value }] of after) {
    if (value === null || !sameFolder(value, target)) continue
    const was = before.get(key)
    if (was?.value != null && sameFolder(was.value, target)) continue
    if (!was) restores.push({ path, action: 'remove' })
    else if (was.value === null) restores.push({ path, action: 'clear' })
    else restores.push({ path, action: 'set', value: was.value })
  }
  return restores
}

/** The PowerShell command that carries out one restore. */
export function restoreCommand({ path, action, value }) {
  const key = quoted(`HKCU:\\${path}`)
  if (action === 'remove') return `Remove-Item -LiteralPath ${key} -Recurse -Force`
  if (action === 'clear') return `Remove-ItemProperty -LiteralPath ${key} -Name '(default)' -Force`
  return `Set-Item -LiteralPath ${key} -Value ${quoted(value)}`
}

function restoreInstallLocation(before, target) {
  for (const restore of installLocationRestores(before, softwareKeys(), target)) {
    powershell(restoreCommand(restore))
    if (restore.action === 'set' && !existsSync(restore.value)) {
      console.warn(`HKCU\\${restore.path} pointed at ${restore.value} before this install, a folder that does not exist (left by another tool?); it is put back as it was — the next plain install of the product goes there`)
    }
  }
}

/**
 * Which of the files a release download left in a folder is the installer of `tag`: the one file
 * ending like `pattern`, or — when the release also carries a copy under a name without the version
 * (kept for a link that always reaches the latest installer) — the one naming the tag's version, as
 * the bundler names it (`<product>_<version>_x64-setup.exe`). Null when that is still not one file.
 */
export function pickReleaseInstaller(files, { tag, pattern = '*_x64-setup.exe' }) {
  const suffix = pattern.replace(/^\*/, '')
  const found = files.filter((f) => f.endsWith(suffix))
  if (found.length === 1) return found[0]
  const versioned = found.filter((f) => f.includes(`_${tag.replace(/^v/, '')}_`))
  return versioned.length === 1 ? versioned[0] : null
}

/** Downloads the published installer of `tag` into `dir` and answers its path. */
export async function downloadInstaller({ repo, tag, dir, pattern = '*_x64-setup.exe' }) {
  gh(['release', 'download', tag, '-R', repo, '--pattern', pattern, '--dir', dir])
  const found = pickReleaseInstaller(await readdir(dir), { tag, pattern })
  if (!found) throw new Error(`release ${tag} of ${repo} has no single ${pattern}`)
  return join(dir, found)
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

/**
 * Runs `body` with the app's data folder set aside, then puts it back — whether `body` passed or not.
 * An installed app started by a check writes where the person's own copy does (its identity, its
 * session and diagnostic records, the web view profile), and a check that ends it by force leaves an
 * unfinished session there for the next real launch to find, or to send. `body` starts from no data
 * folder; what the check's app wrote is removed afterwards.
 *
 * The folder is moved aside to `<appData>.set-aside`. If that is already there, an earlier check
 * ended without putting it back: this refuses to run rather than lose it — move it back by hand.
 *
 * @template T
 * @param {string} appData  the app's data folder, e.g. `%LOCALAPPDATA%\<identifier>`
 * @param {() => Promise<T>} body
 * @param {{ retries?: number }} [options]  retries: tries at removing the check's folder while web view processes let go of it
 */
export async function withAppDataSetAside(appData, body, { retries = 40 } = {}) {
  const aside = `${appData}.set-aside`
  if (existsSync(aside)) throw new Error(`${aside} is left from an earlier check; move it back to ${appData} first`)
  const had = existsSync(appData)
  if (had) {
    try {
      await rename(appData, aside)
    } catch (e) {
      throw new Error(`could not set ${appData} aside (is the app running?): ${e.message}`)
    }
  }
  try {
    return await body()
  } finally {
    await rm(appData, { recursive: true, force: true, maxRetries: retries, retryDelay: 250 })
    if (had) await rename(aside, appData)
  }
}

/**
 * The two releases an update walk goes between: `to` the newest published, `from` the one asked for
 * or the newest published before it. Null when there is no earlier release, or `from` is `to` — a
 * release build looks for updates where it was built to, so the version to update to must already
 * be published.
 *
 * @param {{ tagName: string, publishedAt: string }[]} releases  published (not draft) releases
 * @param {string} [asked]  the tag to update from
 */
export function pickUpdateWalk(releases, asked) {
  const [newest] = [...releases].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  if (!newest) return null
  const from = pickUpgradeFrom(releases, newest.tagName, asked)
  if (!from || from === newest.tagName) return null
  return { from, to: newest.tagName }
}

const UPDATE_STATE = 'tauri-kit-update/1'

/**
 * What `tauri-kit-update` keeps between launches, read from its state file's text; null when it is
 * not that file (missing, unreadable, or written by something else, such as an updater the app had
 * before).
 *
 * @param {string | null | undefined} text
 * @returns {{ announced?: string, ready?: string, failed?: string } | null}
 */
export function readUpdateState(text) {
  if (!text) return null
  try {
    const state = JSON.parse(text)
    return state?.format === UPDATE_STATE ? state : null
  } catch {
    return null
  }
}

const bare = (version) => version.replace(/^v/, '')

/** Whether the app announced `version` and has its installer downloaded and checked. */
export function updateReady(state, version) {
  return state?.announced === bare(version) && state?.ready === bare(version)
}

/** One Windows PowerShell command's output, trimmed. */
function powershell(command) {
  return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).stdout?.trim() ?? ''
}

const quoted = (text) => `'${text.replaceAll("'", "''")}'`

/** The version of `product` this user has installed, from its uninstall entry; null when there is none. */
export function installedVersion(product) {
  const command = `Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object DisplayName -eq ${quoted(product)} | Select-Object -First 1 -ExpandProperty DisplayVersion`
  return powershell(command) || null
}

/** The ids of the running processes whose program is in `dir`. */
export function processesIn(dir) {
  const command = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ${quoted(`${dir}\\*`)} } | ForEach-Object ProcessId`
  return powershell(command).split(/\s+/).filter(Boolean).map(Number)
}

/**
 * Asks a process to close its main window, as a person closing it would, so whatever the app does
 * on close runs — an update installed on close among it. Ending it by force would skip that.
 */
export function closeMainWindow(pid) {
  powershell(`(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).CloseMainWindow() | Out-Null`)
}

/**
 * Presses the button named `name` in a process's main window, as a person clicking it would — through
 * Windows UI Automation, which reads the page of a web view as it reads native controls, so it needs
 * no debugging port and works on a release build. Answers whether it was pressed: the window and the
 * button must be there.
 */
export function pressButton(pid, name) {
  const script = [
    'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
    `$handle = (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).MainWindowHandle`,
    "if (-not $handle -or $handle -eq 0) { 'no window'; exit }",
    '$a = [System.Windows.Automation.AutomationElement]',
    '$button = New-Object System.Windows.Automation.AndCondition(',
    '  (New-Object System.Windows.Automation.PropertyCondition($a::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),',
    `  (New-Object System.Windows.Automation.PropertyCondition($a::NameProperty, ${quoted(name)})))`,
    '$found = $a::FromHandle($handle).FindFirst([System.Windows.Automation.TreeScope]::Descendants, $button)',
    "if (-not $found) { 'no button'; exit }",
    '$found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()',
    "'pressed'",
  ].join('\n')
  return powershell(script) === 'pressed'
}

/**
 * Waits until the button named `name` is in a process's main window and presses it — the `install`
 * of `walkUpdate` for an app that installs when the person says so.
 */
export async function pressButtonWhenShown(pid, name, { timeoutMs = 60_000 } = {}) {
  if (!(await until(() => pressButton(pid, name), timeoutMs, 1000))) {
    throw new Error(`no button named ${JSON.stringify(name)} in the window of process ${pid} within ${timeoutMs} ms`)
  }
}

async function until(what, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const answer = await what()
    if (answer || Date.now() >= end) return answer
    await sleep(everyMs)
  }
}

/**
 * Walks the update a person's copy takes on its own: installs the previous published release
 * (`withInstalled`), starts it, waits until it finds the newest release and has its installer
 * downloaded and checked (read from the `tauri-kit-update` state file), has it install the update
 * (`install` — by default closing its main window, for an app that installs on close), and checks
 * that the installed version is the new one, that the app was not started again, and that the next
 * launch lets go of the installer it kept. Windows only.
 *
 * The update installer runs without a folder and installs where the previous version was, so the
 * walk installs into a temporary folder like `withInstalled`; but the uninstall entry is the user's
 * own, so it refuses to run while `product` is installed. Wrap it in `withAppDataSetAside` to leave
 * the person's data folder as it was.
 *
 * Each step is answered as `{ name, ok, detail }`; the walk goes on after a failed step only where
 * the next one still means something, and always uninstalls.
 *
 * @param {object} options
 * @param {string} options.repo  where the releases are published (`owner/name`)
 * @param {string} options.exe  the app's file name
 * @param {string} options.product  the name of its uninstall entry (the product name)
 * @param {string} options.stateFile  where the app keeps the `tauri-kit-update` state
 * @param {string} [options.from]  the tag to update from (default: the newest before the newest)
 * @param {string} [options.pattern]  the installer among a release's files (default `*_x64-setup.exe`)
 * @param {(version: string) => string} [options.keptInstaller]  where the app keeps a downloaded installer, if in a file
 * @param {(app: { pid: number, target: string }) => Promise<void> | void} [options.install]  starts the update's install
 * @param {boolean} [options.restarts]  whether the install starts the app again (default false)
 * @param {(target: string) => Promise<void> | void} [options.before]  the app's own checks before updating (e.g. leave a mark in its data)
 * @param {(target: string) => Promise<void> | void} [options.after]  the app's own checks on the updated copy, while it runs
 * @param {{ ready?: number, installed?: number, cleared?: number }} [options.timeoutsMs]
 * @returns {Promise<{ from: string, to: string, steps: { name: string, ok: boolean, detail?: string }[] }>}
 */
export async function walkUpdate({
  repo,
  exe,
  product,
  stateFile,
  from: asked,
  pattern = '*_x64-setup.exe',
  keptInstaller,
  install = ({ pid }) => closeMainWindow(pid),
  restarts = false,
  before,
  after,
  timeoutsMs = {},
}) {
  const { ready: readyMs = 10 * 60_000, installed: installedMs = 3 * 60_000, cleared: clearedMs = 3 * 60_000 } = timeoutsMs
  const walk = pickUpdateWalk(publishedReleases(repo), asked)
  if (!walk) throw new Error(`${repo} has no published release to update from${asked ? ` (${asked})` : ''} to its newest`)
  const { from, to } = walk
  const already = installedVersion(product)
  if (already) throw new Error(`${product} ${already} is installed; the walk would take over its uninstall entry — uninstall it first`)

  const steps = []
  const step = (name, ok, detail) => {
    steps.push({ name, ok: Boolean(ok), ...(detail ? { detail: String(detail) } : {}) })
    return Boolean(ok)
  }
  const state = async () => readUpdateState(await readFile(stateFile, 'utf8').catch(() => null))
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'tauri-app-update-')))
  try {
    const installer = await downloadInstaller({ repo, tag: from, dir, pattern })
    await withInstalled(installer, async (target) => {
      const app = join(target, exe)
      const start = () => spawn(app, [], { stdio: 'ignore', detached: true }).unref()
      try {
        step(`installed ${from}`, installedVersion(product) === bare(from), installedVersion(product))
        await before?.(target)

        start()
        const pid = await until(() => processesIn(target)[0], 30_000, 500)
        const found = await until(async () => updateReady(await state(), to), readyMs, 5000)
        if (!step(`found ${to} and has its installer ready`, pid && found, JSON.stringify(await state()))) return
        if (keptInstaller) step('kept the installer in a file', existsSync(keptInstaller(bare(to))), keptInstaller(bare(to)))

        await install({ pid, target })
        // The uninstall entry is written before the files are: wait for the program itself to be the new one.
        const updated = await until(() => installedVersion(product) === bare(to) && fileVersion(app).startsWith(bare(to)), installedMs)
        if (!step(`installed ${to}`, updated, `entry ${installedVersion(product)} · ${exe} ${fileVersion(app)}`)) return
        // An installer that starts the app does so as it finishes; give it the time to.
        const running = await until(() => processesIn(target).length > 0, restarts ? 60_000 : 5000, 500)
        step(restarts ? 'started the app again' : 'did not start the app', restarts === running, processesIn(target).join(' '))

        if (!running) start()
        const cleared = await until(async () => {
          const s = await state()
          return Boolean(s && !s.ready && !(keptInstaller && existsSync(keptInstaller(bare(to)))))
        }, clearedMs, 5000)
        step('the next launch let go of the installer', cleared, JSON.stringify(await state()))
        await after?.(target)

        for (const id of processesIn(target)) closeMainWindow(id)
        step('closed', await until(() => !processesIn(target).length, 30_000, 500), processesIn(target).join(' '))
      } finally {
        // A walk that stopped early leaves the app running, and the uninstaller cannot remove what it holds.
        for (const id of processesIn(target)) {
          try {
            process.kill(id)
          } catch {}
        }
      }
    }, { exe })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  return { from, to, steps }
}

/** Leaves a profile copy the way a runtime update would, so a check can see the app remove it. */
export async function seedProfileSnapshot(appData) {
  const dir = join(profileSnapshots(appData), '1.0.0.0', 'Default')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Web Data'), 'an entry typed into an earlier version')
}
