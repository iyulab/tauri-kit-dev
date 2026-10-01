// Starts a debug build of a Tauri app with WebView2's debugging port open, drives its window over
// CDP, and runs an app's scenarios against it — in order, against a fresh start, as many times as
// asked. What the app is called, which port it uses and when its window counts as ready are the
// app's to say.

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
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
   */
  static async launch(options) {
    const { exe, port, ready = `document.readyState === 'complete'`, env = {}, args = [], helpersName = '__e2e', debugPortFromEnv = true, timeoutMs = 60_000 } = options
    // A window left over from an earlier run would answer in place of the one about to start.
    if (await portAnswers(port)) {
      throw new Error(`something already answers on debugging port ${port} — close the window an earlier run left open`)
    }
    const app = new App()
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
    const next = await App.launch({ ...this.#options, env: { ...this.#options.env, ...env } })
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
  }

  get #h() {
    return this.#options.helpersName ?? '__e2e'
  }

  /** Clicks, with the mouse, the element matching `selector` (and whose label is `text`, if given). */
  async click(selector, text) {
    const box = await this.cdp.waitFor(
      `(() => { const el = ${this.#h}.one(${q(selector)}, ${q(text)}); return el && !el.disabled && !el.hasAttribute('disabled') && ${this.#h}.target(el) })()`,
      `${selector}${text ? ` "${text}"` : ''} to be clickable`,
    )
    await this.cdp.clickAt(box)
  }

  /** Focuses the field matching `selector`, selects what it holds, and types `text` over it. */
  async fill(selector, text) {
    await this.cdp.waitFor(
      `(() => { const el = ${this.#h}.one(${q(selector)}); if (!el || el.disabled) return false; el.focus(); el.select?.(); return true })()`,
      `field ${selector}`,
    )
    await this.cdp.insertText(text)
  }
}

/**
 * Reads `--through <part of a name>` and `--repeat <n>`: the scenarios up to the first whose name
 * contains that text, run n times over.
 *
 * @param {string[]} names  the scenarios, in order
 * @param {string[]} argv
 */
export function selectScenarios(names, argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const known = new Set(['--through', '--repeat'])
  const unknown = argv.filter((a, i) => a.startsWith('--') && !known.has(a) && !known.has(argv[i - 1]))
  if (unknown.length) throw new Error(`unknown option: ${unknown.join(' ')} (expected --through <text>, --repeat <n>)`)
  const through = value('--through')
  const repeat = Number(value('--repeat') ?? 1)
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat takes a whole number of runs, 1 or more')
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
 * @param {string[]} [options.argv]          `--through`, `--repeat` (default: this process's arguments)
 * @param {string} [options.screenshots]     a folder for a picture after each scenario (default: E2E_SCREENSHOTS)
 * @param {(app: App) => Promise<string>} [options.shown]  what the window showed when a scenario failed
 * @param {(line: string) => void} [options.log]
 */
export async function runScenarios(scenarios, { start, argv = process.argv.slice(2), screenshots = process.env.E2E_SCREENSHOTS, shown, log = console.log }) {
  const { selected, repeat } = selectScenarios(Object.keys(scenarios), argv)
  const picture = async (app, name) => {
    if (!screenshots || !app.child) return
    await mkdir(screenshots, { recursive: true })
    await writeFile(join(screenshots, pictureName(name)), await app.cdp.screenshot())
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
          await picture(run.app, `FAILED ${name}`).catch(() => {})
          return name
        }
      }
      return undefined
    } finally {
      await run?.app?.quit()
      await run?.stop?.()
    }
  }

  const failures = []
  for (let n = 1; n <= repeat; n++) {
    if (repeat > 1) log(`\nrun ${n} of ${repeat}`)
    const failed = await runOnce()
    if (failed) failures.push(failed)
  }
  if (repeat === 1) log(failures.length ? `\n${failures.length} scenario failed` : `\nall ${selected.length} scenarios passed`)
  else log(`\n${repeat - failures.length} of ${repeat} runs passed${failures.length ? ` — failed: ${[...new Set(failures)].join(', ')}` : ''}`)
  return failures.length ? 1 : 0
}
