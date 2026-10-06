// Starts a debug build of a Tauri app with WebView2's debugging port open, drives its window over
// CDP, and runs an app's scenarios against it — in order, against a fresh start, as many times as
// asked. What the app is called, which port it uses and when its window counts as ready are the
// app's to say.

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
 * The environment that opens WebView2's debugging port. An app that passes WebView2 its own
 * browser arguments replaces this variable; such an app opens the port in its test configuration
 * instead, and `launch` is given `debugPortFromEnv: false`.
 */
export function debugEnv(port, env = process.env) {
  const given = env[WEBVIEW2_ARGUMENTS]
  return { [WEBVIEW2_ARGUMENTS]: [given, `--remote-debugging-port=${port}`].filter(Boolean).join(' ') }
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
   */
  static async launch(options) {
    const { exe, port, ready = `document.readyState === 'complete'`, env = {}, args = [], helpersName = '__e2e', debugPortFromEnv = true, timeoutMs = 60_000 } = options
    // A window left over from an earlier run would answer in place of the one about to start.
    if (await portAnswers(port)) {
      throw new Error(`something already answers on debugging port ${port} — close the window an earlier run left open`)
    }
    // `this`: an app's own subclass launches as itself.
    const app = new this()
    app.#options = options
    app.child = spawn(exe, args, { stdio: 'ignore', env: { ...process.env, ...(debugPortFromEnv ? debugEnv(port) : {}), ...env } })
    const exited = new Promise((_, reject) => app.child.once('exit', (code) => reject(new Error(`${exe} exited with ${code} before its window was ready`))))
    exited.catch(() => {})
    try {
      const page = await Promise.race([findPage(port, { timeoutMs }), exited])
      app.cdp = await Cdp.connect(page.webSocketDebuggerUrl)
      await Promise.race([app.cdp.waitFor(ready, 'the window to be ready', { timeoutMs }), exited])
      await app.cdp.evaluate(helpers(helpersName))
    } catch (e) {
      await app.quit()
      throw e
    }
    return app
  }

  /** Ends the app the hard way and starts it again in this same App, with `env` added. */
  async restart(env = {}) {
    await this.quit()
    const next = await this.constructor.launch({ ...this.#options, env: { ...this.#options.env, ...env } })
    this.child = next.child
    this.cdp = next.cdp
  }

  /**
   * Ends the app and waits until it has gone — its web view too: the WebView2 browser process
   * outlives the app's own by a moment and keeps answering on the debugging port meanwhile.
   */
  async quit() {
    this.cdp?.close()
    const child = this.child
    if (!child) return
    child.kill()
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
 * @param {(line: string) => void} [options.log]
 */
export async function runScenarios(scenarios, {
  start,
  argv = process.argv.slice(2),
  screenshots = process.env.E2E_SCREENSHOTS,
  failures = join(tmpdir(), 'tauri-kit-dev-failures', new Date().toISOString().replace(/[:.]/g, '-')),
  shown,
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

  const runOnce = async () => {
    let run
    try {
      run = await start()
      for (const name of selected) {
        try {
          await scenarios[name](run.app, run.context)
          log(`  ✓ ${name}`)
          await picture(run.app, name)
        } catch (e) {
          const said = shown && run.app.child ? await shown(run.app).catch(() => '') : ''
          log(`  ✗ ${name}\n    ${String(e.message).replaceAll('\n', '\n    ')}${said ? `\n    the window showed: ${said}` : ''}`)
          const kept = await picture(run.app, `FAILED ${name}`, screenshots ?? failures).catch(() => undefined)
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
