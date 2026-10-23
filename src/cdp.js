// A small Chrome DevTools Protocol client for driving a WebView2 window (or any Chromium page) that
// exposes a remote debugging port. Uses Node's built-in WebSocket, so it needs no dependency.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits until the debugging endpoint on `port` lists a page, and returns its target.
 *
 * @param {number} port
 * @param {{ timeoutMs?: number, host?: string }} [options]
 */
export async function findPage(port, { timeoutMs = 60_000, host = '127.0.0.1' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://${host}:${port}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page
    } catch (e) {
      lastError = e
    }
    await sleep(250)
  }
  throw new Error(`no page on debugging port ${port} (${lastError?.message ?? 'none listed'})`)
}

/** Whether something already answers on the debugging port — a window left over from an earlier run. */
export async function portAnswers(port, { host = '127.0.0.1' } = {}) {
  try {
    await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

export class Cdp {
  #ws
  #nextId = 1
  #pending = new Map()
  /** @type {Map<string, Set<(params: any) => void>>} */
  #listeners = new Map()
  #closed = false

  /** Connects to a target's `webSocketDebuggerUrl`. */
  static async connect(url) {
    const cdp = new Cdp()
    cdp.#ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener('open', resolve, { once: true })
      cdp.#ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true })
    })
    cdp.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      // An event the window sends of its own accord, not an answer.
      if (message.id === undefined) {
        for (const listener of cdp.#listeners.get(message.method) ?? []) listener(message.params)
        return
      }
      const pending = cdp.#pending.get(message.id)
      if (!pending) return
      cdp.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
      else pending.resolve(message.result)
    })
    // A window that goes away takes its answers with it: fail what is waiting instead of leaving it
    // pending forever, which would end the run with nothing said.
    cdp.#ws.addEventListener('close', () => {
      cdp.#closed = true
      for (const { reject, method } of cdp.#pending.values()) reject(new Error(`${method}: the window's debugging connection closed`))
      cdp.#pending.clear()
    })
    return cdp
  }

  /**
   * Sends one protocol command and resolves with its result. With `timeoutMs`, a command the window
   * has not answered by then fails instead of waiting on: a page that hangs keeps a command pending
   * while the connection stays open.
   */
  send(method, params = {}, { timeoutMs } = {}) {
    if (this.#closed) return Promise.reject(new Error(`${method}: the window's debugging connection is closed`))
    const id = this.#nextId++
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      if (timeoutMs === undefined) return this.#pending.set(id, { resolve, reject, method })
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method}: no answer within ${timeoutMs / 1000} s`))
      }, timeoutMs)
      const settle = (fn) => (value) => (clearTimeout(timer), fn(value))
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject), method })
    })
  }

  /**
   * Calls `listener` with the parameters of each `method` event the window sends — `Runtime.consoleAPICalled`, say,
   * once `Runtime.enable` has been sent. Answers a function that stops it.
   *
   * @param {string} method
   * @param {(params: any) => void} listener
   */
  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? new Set()
    this.#listeners.set(method, listeners.add(listener))
    return () => listeners.delete(listener)
  }

  /** Evaluates `expression` in the page and returns its (awaited) value; `timeoutMs` as for `send`. */
  async evaluate(expression, { timeoutMs } = {}) {
    const { result, exceptionDetails } = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      { timeoutMs },
    )
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    }
    return result.value
  }

  /**
   * Polls `expression` until it returns a truthy value, and returns that value — or fails at the deadline,
   * even when one evaluation never answers.
   */
  async waitFor(expression, what, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression, { timeoutMs: Math.max(1, deadline - Date.now()) })
        if (value) return value
      } catch (e) {
        lastError = e
      }
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${what}${lastError ? ` (${lastError.message})` : ''}`)
  }

  /** Types text into the focused element, as the keyboard's text input would. */
  insertText(text) {
    return this.send('Input.insertText', { text })
  }

  /** Presses one key, with optional modifiers (1 = Alt, 2 = Ctrl, 4 = Meta, 8 = Shift). */
  async press(key, { code = key, modifiers = 0, keyCode } = {}) {
    const base = { key, code, modifiers, windowsVirtualKeyCode: keyCode }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** Clicks a point given in page coordinates. */
  async clickAt({ x, y }) {
    const at = { x, y, button: 'left', clickCount: 1 }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at })
  }

  /** A PNG of the page as it is now. */
  async screenshot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(data, 'base64')
  }

  /** Closes the connection; what is still waiting for an answer fails now rather than when the window lets go. */
  close() {
    this.#closed = true
    for (const { reject, method } of this.#pending.values()) reject(new Error(`${method}: the window's debugging connection closed`))
    this.#pending.clear()
    this.#ws.close()
  }
}
