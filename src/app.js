// Starts a debug build of a Tauri app with WebView2's debugging port open, drives its window over
// CDP, and runs an app's scenarios against it — in order, against a fresh start, as many times as
// asked. What the app is called, which port it uses and when its window counts as ready are the
// app's to say.

import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Cdp, findPage, portAnswers } from './cdp.js'

/**
 * In-page helpers, installed as `window[name]`: queries that pierce shadow roots, element boxes,
 * and the box to click once a click there would land on the element.
 */
export function helpers(name = '__e2e') {
  return `window[${JSON.stringify(name)}] = {
  all(selector, root = document) {
    const found = [...root.querySelectorAll(selector)]
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) found.push(...this.all(selector, el.shadowRoot))
    return found
  },
  one(selector, text) {
    // An item's text may lead with an icon ("◉ Name"); the label is what follows.
    const matches = (el) => {
      const t = el.textContent.replace(/\\s+/g, ' ').trim()
      return t === text || t.endsWith(' ' + text)
    }
    return this.all(selector).find((el) => text === undefined || matches(el))
  },
  box(el) {
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  },
  /**
   * The box to click, once a click there would land on el and the box held still since the last
   * poll: a smooth scroll still under way would move el between measuring and clicking.
   */
  target(el) {
    const b = this.box(el)
    const last = this.lastBox
    this.lastBox = b
    if (!last || last.x !== b.x || last.y !== b.y) return false
    let hit = document.elementFromPoint(b.x, b.y)
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(b.x, b.y)
      if (!inner || inner === hit) break
      hit = inner
    }
    for (let n = hit; n; n = n.parentNode ?? n.host) if (n === el) return b
    return false
  },
  /**
   * Watches the next press for whether it lands on el, still enabled. The page can move or turn off
   * el in the moment between measuring its box and the press arriving; a press that misses is kept
   * from whatever it hit instead, and disarm() says so, so the click can be tried again.
   */
  arm(el) {
    if (!this.listening) {
      this.listening = true
      const watch = (e) => {
        const armed = this.armed
        if (!armed) return
        if (armed.landed === undefined && e.type === 'pointerdown') {
          const off = (node) => node.disabled || node.hasAttribute?.('disabled')
          armed.landed = e.composedPath().includes(armed.el) && !off(armed.el)
        }
        if (armed.landed === false) {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
      }
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.addEventListener(type, watch, true)
    }
    this.armed = { el, landed: undefined }
  },
  /** Whether the press since arm() landed on its element; a press that never arrived did not. */
  disarm() {
    const landed = this.armed?.landed === true
    this.armed = undefined
    return landed
  },
}; true`
}

const q = (s) => JSON.stringify(s)

/** The environment variable WebView2 reads extra browser arguments from. */
export const WEBVIEW2_ARGUMENTS = 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'

/**
 * The environment that carries WebView2's debugging port to the app. Current WebView2 runtimes do not
 * apply this variable to an app that passes browser arguments of its own — and a Tauri app always
 * does (its web view library passes defaults) — so the app's debug build reads the variable and puts
 * it into its window's own browser arguments (README, "Opening the debugging port"). An app that opens
 * the port some other way is launched with `debugPortFromEnv: false`.
 */
export function debugEnv(port, env = process.env) {
  const given = env[WEBVIEW2_ARGUMENTS]
  return { [WEBVIEW2_ARGUMENTS]: [given, `--remote-debugging-port=${port}`].filter(Boolean).join(' ') }
}

/**
 * Why a window never opened its debugging port, read from the command lines of the WebView2 processes
 * on the computer: whether a browser was started for the app (`--webview-exe-name=<exeName>`), and
 * whether it was given the port. Answers a sentence, or undefined when the browser did carry the port
 * — then the cause lies elsewhere and there is nothing more to say.
 *
 * @param {number} port
 * @param {string} exeName       the file name of the app's executable
 * @param {string[]} commandLines of the `msedgewebview2.exe` processes
 */
export function debugPortDiagnosis(port, exeName, commandLines) {
  const browsers = commandLines.filter((line) => line.includes(`--webview-exe-name=${exeName}`) && !line.includes('--type='))
  if (browsers.length === 0) return `no WebView2 browser was started for ${exeName} — the window never opened its web view`
  if (browsers.some((line) => line.includes(`--remote-debugging-port=${port} `) || line.endsWith(`--remote-debugging-port=${port}`))) return undefined
  return (
    `the WebView2 browser for ${exeName} started without --remote-debugging-port=${port}: the runtime did not apply ` +
    `${WEBVIEW2_ARGUMENTS}, which current runtimes leave out when the app passes browser arguments of its own (a Tauri ` +
    `app always does). The debug build has to put the port into its window's browser arguments — see "Opening the ` +
    `debugging port" in the README`
  )
}

/** The command lines of the WebView2 processes running now — Windows only; elsewhere there are none to read. */
async function webviewCommandLines(platform = process.platform) {
  if (platform !== 'win32') return undefined
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ForEach-Object CommandLine`
  const { stdout } = await promisify(execFile)('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return stdout.split(/\r?\n/).filter(Boolean)
}

export class App {
  /** @type {import('node:child_process').ChildProcess | undefined} */
  child
  /** @type {Cdp} */
  cdp
  #options

  /**
   * Starts the app and waits for its window.
   *
   * @param {object} options
   * @param {string} options.exe              the debug build to start
   * @param {number} options.port             the debugging port its window opens
   * @param {string} [options.ready]          an expression that is truthy once the window is ready
   * @param {Record<string, string>} [options.env]  added to this process's environment
   * @param {string[]} [options.args]
   * @param {string} [options.helpersName]    where the in-page helpers go (default `__e2e`)
   * @param {boolean} [options.debugPortFromEnv]  open the port through WebView2's environment variable (default true)
   * @param {number} [options.timeoutMs]      how long to wait for the window (default 60 s)
   * @param {string} [options.webviewProfile] text in the command line of the app's WebView2 processes — its
   *        identifier, which names its profile folder. `quit` then also waits for those processes (Windows).
   * @param {string[]} [options.leftovers]    executables an earlier run may have left running — the app's, its
   *        helpers' (`notes.exe`, `Notes.Host.exe`) — ended before the app starts (see `endLeftovers`)
   */
  static async launch(options) {
    const { exe, port, ready = `document.readyState === 'complete'`, env = {}, args = [], helpersName = '__e2e', debugPortFromEnv = true, timeoutMs = 60_000, leftovers = [] } = options
    if (leftovers.length) await endLeftovers(leftovers)
    // A window left over from an earlier run would answer in place of the one about to start.
    if (await portAnswers(port)) {
      throw new Error(`something already answers on debugging port ${port} — close the window an earlier run left open`)
    }
    // `this`: an app's own subclass launches as itself.
    const app = new this()
    app.#options = options
    const environment = { ...process.env, ...(debugPortFromEnv ? debugEnv(port) : {}), ...env }
    // A development command (`tauri dev`) runs through a shell, in its own process group where there is one, so `quit`
    // ends everything it started — the dev server, the build, the app — and not only the shell.
    app.child = options.command
      ? spawn(options.command, { cwd: options.cwd, shell: true, stdio: 'ignore', env: environment, detached: process.platform !== 'win32' })
      : spawn(exe, args, { stdio: 'ignore', env: environment })
    // A run that ends without quitting — an error past its `finally`, `process.exit`, a hang given up on
    // with Ctrl+C — would leave the window running, and the next launch would meet it.
    app.#endWithProcess(app.child)
    const exited = new Promise((_, reject) =>
      app.child.once('exit', (code) => reject(new Error(`${exe ?? options.command} exited with ${code} before its window was ready`))),
    )
    exited.catch(() => {})
    try {
      const page = await Promise.race([findPage(port, { timeoutMs }), exited])
      app.cdp = await Cdp.connect(page.webSocketDebuggerUrl)
      await Promise.race([app.cdp.waitFor(ready, 'the window to be ready', { timeoutMs }), exited])
      await app.cdp.evaluate(helpers(helpersName))
    } catch (e) {
      // Asked while the app still runs: its browser's command line says whether the port ever reached it.
      const why = String(e?.message).startsWith('no page on debugging port') && exe
        ? await webviewCommandLines().then((lines) => lines && debugPortDiagnosis(port, basename(exe), lines)).catch(() => undefined)
        : undefined
      await app.quit()
      throw why ? new Error(`${e.message} — ${why}`, { cause: e }) : e
    }
    return app
  }

  /**
   * Starts the app the way it is developed — `command` (default `npx tauri dev`) run in `cwd`, which builds it and
   * starts it, its front end served by a dev server — and waits for its window as `launch` does for a built one. The
   * first build takes minutes, so the window is waited for longer (default 10 minutes). `quit` ends everything the
   * command started. Its other options are `launch`'s.
   *
   * @param {Omit<Parameters<typeof App.launch>[0], 'exe' | 'args'> & { cwd: string, command?: string }} options
   */
  static async launchDev({ command = 'npx tauri dev', timeoutMs = 600_000, ...options }) {
    if (!options.cwd) throw new Error('launchDev needs { cwd } — the folder the dev command runs in')
    return this.launch({ ...options, command, timeoutMs })
  }

  /** Ends the app the hard way and starts it again in this same App, with `env` added. */
  async restart(env = {}) {
    await this.quit()
    const next = await this.constructor.launch({ ...this.#options, env: { ...this.#options.env, ...env } })
    this.child = next.child
    this.cdp = next.cdp
    this.#stopEnding = next.#stopEnding
  }

  #stopEnding

  /** Ends `child` when this process exits or is interrupted, until `quit` ends it first. */
  #endWithProcess(child) {
    const tree = Boolean(this.#options?.command)
    const end = () => {
      if (child.exitCode === null && child.signalCode === null) tree ? endTree(child) : child.kill()
    }
    // Ctrl+C would otherwise end this process without its `exit` handlers; with a handler of ours
    // the default goes away, so the interrupt ends the process once the window is ended.
    const interrupted = () => {
      end()
      if (process.listenerCount('SIGINT') === 0) process.exit(130)
    }
    process.once('exit', end)
    process.once('SIGINT', interrupted)
    this.#stopEnding = () => {
      process.off('exit', end)
      process.off('SIGINT', interrupted)
    }
  }

  /**
   * Ends the app and waits until it has gone — its web view too: the WebView2 browser process
   * outlives the app's own by a moment and keeps answering on the debugging port meanwhile.
   */
  async quit() {
    this.cdp?.close()
    this.#stopEnding?.()
    this.#stopEnding = undefined
    const child = this.child
    if (!child) return
    if (this.#options.command) endTree(child)
    else child.kill()
    await new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done)))
    this.child = undefined
    const until = Date.now() + 15_000
    while ((await portAnswers(this.#options.port)) && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
    // A launch that joins a browser still shutting down on the same profile never opens the port.
    if (this.#options.webviewProfile) await webviewGone(this.#options.webviewProfile)
  }

  get #h() {
    return this.#options?.helpersName ?? '__e2e'
  }

  /**
   * Clicks, with the mouse, the element matching `selector` (and whose label is `text`, if given). A press
   * the page moved out from under — or that found the element turned off — is kept from what it hit and
   * tried again, up to `attempts` times.
   */
  async click(selector, text, { attempts = 5 } = {}) {
    const what = `${selector}${text ? ` "${text}"` : ''}`
    for (let attempt = 1; ; attempt++) {
      const box = await this.cdp.waitFor(
        `(() => { const h = ${this.#h}, el = h.one(${q(selector)}, ${q(text)}); const b = el && !el.disabled && !el.hasAttribute('disabled') && h.target(el); if (b) h.arm(el); return b })()`,
        `${what} to be clickable`,
      )
      await this.cdp.clickAt(box)
      // Without the helpers the press took the page somewhere else: it landed.
      if (await this.cdp.evaluate(`window[${q(this.#h)}]?.disarm() ?? true`)) return
      if (attempt === attempts) throw new Error(`a click on ${what} missed it ${attempts} times — the window kept moving it or turning it off`)
      // Said, not hidden: a window that moves what a person is about to click is worth a look.
      console.warn(`    (a click on ${what} missed it — trying again)`)
    }
  }

  /**
   * Focuses the field matching `selector` — an input, a textarea or an editable element — selects what it
   * holds, and types `text` over it.
   */
  async fill(selector, text) {
    await this.cdp.waitFor(
      `(() => { const el = ${this.#h}.one(${q(selector)}); if (!el || el.disabled) return false; el.focus()
        if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r) }
        else el.select?.()
        return true })()`,
      `field ${selector}`,
    )
    await this.cdp.insertText(text)
  }
}

/**
 * Ends `child` and every process it started — a development command's dev server, build and app outlive the shell
 * that started them otherwise. Synchronous, so it can run as this process exits.
 */
export function endTree(child, platform = process.platform) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  if (platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      // Started detached: its own process group, whose id is its pid.
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill()
    }
  }
}

/**
 * Ends what an earlier run left running: every process of each executable in `names` (`notes.exe`, `Notes.Host.exe`).
 * A run that was given up on can leave the app, or a helper it started, holding the debugging port, the data folder or
 * a file a build replaces. Only the names given are touched; one that is not running is passed over. Answers the names
 * that were running. Windows only — the executables named are Windows'; elsewhere there is nothing to end.
 *
 * @param {string[]} names
 */
export async function endLeftovers(names, { platform = process.platform } = {}) {
  if (platform !== 'win32' || names.length === 0) return []
  for (const name of names) if (!/^[\w.-]+\.exe$/i.test(name)) throw new Error(`leftovers take executable names (notes.exe), not "${name}"`)
  const ended = []
  for (const name of names) {
    const result = spawnSync('taskkill', ['/IM', name, '/T', '/F'], { encoding: 'utf8' })
    if (result.status === 0) ended.push(name)
  }
  return ended
}

/**
 * The discovery file a helper process writes once it listens — `{ "port": …, … }`, as tauri-kit's `DiscoveryFile`
 * publishes it — read as soon as it is there and whole. A dev run's helper is started by the build, not by the run, so
 * where it listens is learned from this file.
 *
 * @param {string} path @param {{ timeoutMs?: number }} [options]
 */
export async function readDiscovery(path, { timeoutMs = 60_000 } = {}) {
  const { readFile } = await import('node:fs/promises')
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (e) {
      // Not there yet, or caught half-written: asked again until it is whole.
      if (Date.now() > until) throw new Error(`no discovery file at ${path} within ${Math.round(timeoutMs / 1000)} s (${e.code ?? e.message})`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

/**
 * Waits until no WebView2 process runs whose command line holds `profile`. A killed app's browser notices
 * only after a while; past `graceMs` the leftovers, which belong to that profile alone, are ended too, and
 * given `killMs` to go. A process ended by force does go, but on a machine whose cores are all busy its
 * teardown takes its turn — 13–17 s was seen with every core saturated, against well under a second idle.
 * WebView2 is Windows' web view, so elsewhere there is nothing to wait for.
 */
export async function webviewGone(profile, { graceMs = 10_000, killMs = 60_000, platform = process.platform } = {}) {
  if (platform !== 'win32') return
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  // An identifier: letters, digits, dots and dashes — nothing a PowerShell wildcard or quote would read.
  if (!/^[\w.-]+$/.test(profile)) throw new Error(`webviewProfile takes an app identifier, not "${profile}"`)
  // The process table can still list a process that has exited while something holds a handle to it;
  // only ones Get-Process can open are running.
  const running = `Get-Process -Id $_ -ErrorAction SilentlyContinue`
  // One PowerShell per wait, polling inside itself: starting PowerShell is the costly part, and on a
  // saturated machine a start every poll competes with the very teardown being waited for.
  const wait = async (ms, { end }) => {
    const script = `$ids = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object ProcessId)
${end ? `$ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }` : ''}
$until = (Get-Date).AddMilliseconds(${ms})
do { $ids = @($ids | Where-Object { ${running} }); if (-not $ids.Count) { break }; Start-Sleep -Milliseconds 250 } while ((Get-Date) -lt $until)
$ids.Count`
    const { stdout } = await promisify(execFile)('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    return Number(stdout.trim()) === 0
  }
  if (await wait(graceMs, { end: false })) return
  if (!(await wait(killMs, { end: true }))) throw new Error(`WebView2 on the profile ${profile} did not exit within ${killMs / 1000} s of being ended`)
}

/**
 * Reads `--through <part of a name>`, `--only <part of a name>` and `--repeat <n>`: the scenarios up to
 * the first whose name contains that text — or only those whose names contain it, for scenarios that
 * stand on their own, such as measurements — run n times over.
 *
 * @param {string[]} names  the scenarios, in order
 * @param {string[]} argv
 */
export function selectScenarios(names, argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const known = new Set(['--through', '--only', '--repeat'])
  const unknown = argv.filter((a, i) => a.startsWith('--') && !known.has(a) && !known.has(argv[i - 1]))
  if (unknown.length) throw new Error(`unknown option: ${unknown.join(' ')} (expected --through <text>, --only <text>, --repeat <n>)`)
  const through = value('--through')
  const only = value('--only')
  if (through !== undefined && only !== undefined) throw new Error('--through and --only choose differently; give one of them')
  const repeat = Number(value('--repeat') ?? 1)
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat takes a whole number of runs, 1 or more')
  if (only !== undefined) {
    const selected = names.filter((n) => n.includes(only))
    if (!selected.length) throw new Error(`no scenario name contains "${only}"`)
    return { selected, repeat }
  }
  const last = through === undefined ? names.length - 1 : names.findIndex((n) => n.includes(through))
  if (last < 0) throw new Error(`no scenario name contains "${through}"`)
  return { selected: names.slice(0, last + 1), repeat }
}

/** A file name for a scenario's picture: letters and digits of any script, the rest as dashes. */
export function pictureName(name) {
  return `${name.replace(/[^\p{L}\p{N}]+/gu, '-')}.png`
}

/** How long what a failure gathers — what the window showed, its picture — may take. */
const AFTER_FAILURE_MS = 15_000

/** Settles as `promise` does, or fails with `message` once `ms` have passed first. */
function within(ms, promise, message = `no answer within ${ms / 1000} s`) {
  let timer
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  // The race handles `promise` too, so what is let go may still fail later — a hung scenario does once the
  // window is quit — without that ending the run as an unhandled rejection.
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/**
 * Runs scenarios in order against one window, each building on what the last left, and says how
 * it went. Returns the exit code: 0 when every run passed.
 *
 * @param {Record<string, (app: App, context: any) => Promise<void>>} scenarios
 * @param {object} options
 * @param {() => Promise<{ app: App, context?: any, stop?: () => Promise<void> }>} options.start
 *        a fresh start for one run: the app, whatever the scenarios share, and how to clean up
 * @param {string[]} [options.argv]          `--through`, `--only`, `--repeat` (default: this process's arguments)
 * @param {string} [options.screenshots]     a folder for a picture after each scenario (default: E2E_SCREENSHOTS)
 * @param {string} [options.failures]        where the picture of a failure goes without `screenshots`, so a
 *        scenario that fails only sometimes can be read afterwards (default: a new folder in the temp folder)
 * @param {(app: App) => Promise<string>} [options.shown]  what the window showed when a scenario failed
 * @param {number} [options.scenarioTimeoutMs]  how long one scenario may take before it fails as unfinished
 *        (default 5 minutes) — a step with no deadline of its own, waiting on a window that stopped answering,
 *        would otherwise hold the run until something outside ends it, with nothing said
 * @param {(line: string) => void} [options.log]
 */
export async function runScenarios(scenarios, {
  start,
  argv = process.argv.slice(2),
  screenshots = process.env.E2E_SCREENSHOTS,
  failures = join(tmpdir(), 'tauri-kit-dev-failures', new Date().toISOString().replace(/[:.]/g, '-')),
  shown,
  scenarioTimeoutMs = 300_000,
  log = console.log,
}) {
  const { selected, repeat } = selectScenarios(Object.keys(scenarios), argv)
  /** Saves a picture of the window in `dir`; answers where, or nothing when there is no window. */
  const picture = async (app, name, dir = screenshots) => {
    if (!dir || !app.child) return undefined
    const png = await app.cdp.screenshot()
    await mkdir(dir, { recursive: true })
    const file = join(dir, pictureName(name))
    await writeFile(file, png)
    return file
  }

  const gathering = Math.min(AFTER_FAILURE_MS, scenarioTimeoutMs)
  const runOnce = async () => {
    let run
    try {
      run = await start()
      for (const name of selected) {
        try {
          await within(scenarioTimeoutMs, scenarios[name](run.app, run.context), `did not finish within ${scenarioTimeoutMs / 1000} s`)
          log(`  ✓ ${name}`)
          await picture(run.app, name)
        } catch (e) {
          // A window that stopped answering would hold these too: each gets a moment, then is let go.
          const said = shown && run.app.child ? await within(gathering, shown(run.app)).catch(() => '') : ''
          log(`  ✗ ${name}\n    ${String(e.message).replaceAll('\n', '\n    ')}${said ? `\n    the window showed: ${said}` : ''}`)
          const kept = await within(gathering, picture(run.app, `FAILED ${name}`, screenshots ?? failures)).catch(() => undefined)
          if (kept) log(`    picture: ${kept}`)
          return name
        }
      }
      return undefined
    } finally {
      await run?.app?.quit()
      await run?.stop?.()
    }
  }

  const failedRuns = []
  for (let n = 1; n <= repeat; n++) {
    if (repeat > 1) log(`\nrun ${n} of ${repeat}`)
    const failed = await runOnce()
    if (failed) failedRuns.push(failed)
  }
  if (repeat === 1) log(failedRuns.length ? `\n${failedRuns.length} scenario failed` : `\nall ${selected.length} scenarios passed`)
  else log(`\n${repeat - failedRuns.length} of ${repeat} runs passed${failedRuns.length ? ` — failed: ${[...new Set(failedRuns)].join(', ')}` : ''}`)
  return failedRuns.length ? 1 : 0
}
