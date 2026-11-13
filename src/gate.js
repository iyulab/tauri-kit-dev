// Runs an app's checks locally the way a merge gate would — and keeps going. Every step runs even
// after one fails, so one pass reports everything that is red instead of stopping at the first
// failure, and ends with a summary of what passed, what failed and how long each took.
//
// The steps are the app's: a list of named shell commands, in the order to run them. A step marked
// `local` is one CI does not run (it needs a desktop session, a model cache, a signing key …) and
// is labelled so in the summary. A step with `optIn` runs only when that flag is given (or the
// step is named with --only) — the shape of a pre-release gate that adds slow steps around the
// merge steps: `--ship` might add "assemble the bundled helpers" before them and "run the
// end-to-end suite" after.
//
//   --list            print the steps and stop
//   --only a,b        run just these steps (opt-in steps may be named here too)
//   --skip c          run all but these steps
//   --<flag>          run the steps that opt in with this flag
//
// A failed step's last lines are printed again just above the summary, so the reason survives a
// reader (or a script) that keeps only the end of the output.
//
// `preflight` lets the app refuse to start when it can see a step will fail for a reason the step's
// own output would not name — a running debug build holding the executable the build must replace,
// say. It gets the selected steps and returns a message to stop with, or nothing.

import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/**
 * @typedef {{ name: string, cmd: string, local?: boolean, optIn?: string }} Step
 * @typedef {{ list: boolean, only: string[] | null, skip: string[], flags: Set<string> }} GateArgs
 * @typedef {{ steps: Step[], preflight?: (selected: Step[]) => string | void | undefined }} GateConfig
 * @typedef {Step & { ok: boolean, seconds: number, tail?: string[] }} StepResult
 * @typedef {boolean | { ok: boolean, tail?: string[] }} RunOutcome
 */

/** How many of a failed step's last lines are printed again above the summary. */
export const FAILED_TAIL_LINES = 40

/**
 * Keeps the last `limit` lines of text that arrives in pieces.
 *
 * @param {number} limit
 */
export function lineTail(limit) {
  /** @type {string[]} */
  const lines = []
  let partial = ''
  return {
    /** @param {string} chunk */
    push(chunk) {
      const parts = (partial + chunk).split(/\r?\n/)
      partial = parts.pop() ?? ''
      lines.push(...parts)
      if (lines.length > limit) lines.splice(0, lines.length - limit)
    },
    /** @returns {string[]} */
    lines() {
      const all = partial ? [...lines, partial] : [...lines]
      return all.slice(-limit)
    },
  }
}

/**
 * Runs one step's command in a shell, its output shown as it comes and its last lines kept.
 *
 * @param {string} cmd
 * @param {string} cwd
 * @returns {Promise<{ ok: boolean, tail: string[] }>}
 */
export function runShown(cmd, cwd) {
  return new Promise((done) => {
    const tail = lineTail(FAILED_TAIL_LINES)
    const child = spawn(cmd, { cwd, shell: true, stdio: ['inherit', 'pipe', 'pipe'] })
    child.stdout.on('data', (b) => {
      process.stdout.write(b)
      tail.push(b.toString())
    })
    child.stderr.on('data', (b) => {
      process.stderr.write(b)
      tail.push(b.toString())
    })
    child.on('error', (e) => {
      tail.push(`${e.message}\n`)
      done({ ok: false, tail: tail.lines() })
    })
    child.on('close', (code) => done({ ok: code === 0, tail: tail.lines() }))
  })
}

/**
 * Reads the gate's own arguments. The opt-in flags are whatever the steps name; anything else
 * starting with `--` is an error, as is a step name no step has.
 *
 * @param {string[]} argv
 * @param {Step[]} steps
 * @returns {GateArgs}
 */
export function gateArgs(argv, steps) {
  const optIns = new Set(steps.map((s) => s.optIn).filter(Boolean))
  const names = (value, flag) => {
    if (value === undefined) throw new Error(`${flag} needs a value`)
    const list = value.split(',').filter(Boolean)
    const unknown = list.filter((n) => !steps.some((s) => s.name === n))
    if (unknown.length) throw new Error(`unknown step(s): ${unknown.join(', ')} — see --list`)
    return list
  }
  /** @type {GateArgs} */
  const args = { list: false, only: null, skip: [], flags: new Set() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--list') args.list = true
    else if (arg === '--only') args.only = names(argv[++i], arg)
    else if (arg === '--skip') args.skip = names(argv[++i], arg)
    else if (optIns.has(arg)) args.flags.add(arg)
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

/**
 * The steps to run, in their order: named ones with --only, otherwise every step that does not opt
 * in plus those whose flag was given — less any named with --skip.
 *
 * @param {Step[]} steps
 * @param {GateArgs} args
 */
export function selectSteps(steps, { only, skip, flags }) {
  return steps.filter(
    (s) => (only ? only.includes(s.name) : !s.optIn || flags.has(s.optIn)) && !skip.includes(s.name),
  )
}

/** One line per step, for --list. @param {Step[]} steps */
export function listing(steps) {
  const width = Math.max(...steps.map((s) => s.name.length)) + 2
  return steps.map((s) => {
    const tag = s.optIn ? `   (${s.optIn})` : s.local ? '   (local only)' : ''
    return `${s.name.padEnd(width)}${s.cmd}${tag}`
  })
}

/** The summary printed at the end, and whether everything passed. @param {StepResult[]} results */
export function summary(results) {
  const width = Math.max(0, ...results.map((r) => r.name.length)) + 2
  const lines = results.map(
    (r) =>
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}${r.seconds.toFixed(1).padStart(7)}s${r.local ? '  (local only)' : ''}`,
  )
  const failed = results.filter((r) => !r.ok)
  lines.push(failed.length ? `${failed.length} failed: ${failed.map((r) => r.name).join(', ')}` : 'all green')
  return { lines, ok: failed.length === 0 }
}

/**
 * What each failed step last printed, to follow the summary. @param {StepResult[]} results
 */
export function failedTails(results) {
  return results
    .filter((r) => !r.ok && r.tail?.length)
    .flatMap((r) => [`[gate] ── ${r.name} failed; its last ${r.tail.length} line(s):`, ...r.tail.map((l) => `  | ${l}`)])
}

/**
 * Runs the gate and resolves to the exit code: 0 all green, 1 something failed, 2 it did not start
 * (bad arguments, or `preflight` refused).
 *
 * @param {GateConfig & {
 *   argv?: string[], cwd?: string,
 *   run?: (cmd: string, cwd: string) => RunOutcome | Promise<RunOutcome>,
 *   log?: (line: string) => void, error?: (line: string) => void,
 *   now?: () => number,
 * }} options
 */
export async function runGate({
  steps,
  preflight,
  argv = [],
  cwd = process.cwd(),
  run = runShown,
  log = console.log,
  error = console.error,
  now = Date.now,
}) {
  let args
  try {
    args = gateArgs(argv, steps)
  } catch (e) {
    error(`[gate] ${e.message}`)
    return 2
  }
  if (args.list) {
    for (const line of listing(steps)) log(line)
    return 0
  }
  const selected = selectSteps(steps, args)
  const refusal = preflight?.(selected)
  if (refusal) {
    error(`[gate] ${refusal}`)
    return 2
  }
  /** @type {StepResult[]} */
  const results = []
  for (const step of selected) {
    log(`\n[gate] ── ${step.name}: ${step.cmd}`)
    const started = now()
    const outcome = await run(step.cmd, cwd)
    const { ok, tail } = typeof outcome === 'boolean' ? { ok: outcome, tail: undefined } : outcome
    results.push({ ...step, ok, tail, seconds: (now() - started) / 1000 })
  }
  const { lines, ok } = summary(results)
  const tails = failedTails(results)
  if (tails.length) log('')
  for (const line of tails) log(line)
  log('\n[gate] summary')
  for (const line of lines) log(line.startsWith('  ') ? line : `[gate] ${line}`)
  return ok ? 0 : 1
}

/**
 * Loads a gate config: a module whose default export is `{ steps, preflight? }`.
 *
 * @param {string} file
 * @returns {Promise<GateConfig>}
 */
export async function loadGateConfig(file) {
  const config = (await import(pathToFileURL(resolve(file)).href)).default
  if (!config || !Array.isArray(config.steps)) throw new Error(`${file} does not export { steps }`)
  return config
}
