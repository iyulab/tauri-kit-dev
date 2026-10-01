// Checks an installer the way a computer without internet would get the app: in Windows Sandbox
// with networking turned off, the script beside this module (sandbox/inside.ps1) installs it
// silently for the current user, starts it, checks that it started a web view, runs the app's own
// extra checks, and writes what it saw to a result file this module reads back. The sandbox is
// closed afterwards.
//
// Windows Sandbox is an optional Windows feature (Containers-DisposableClientVM) and needs a
// restart after it is turned on. The sandbox is a copy of the host's Windows, so it has the
// WebView2 runtime when the host does: the result says whether it was there before the install,
// and a run on a host that has it proves "no network", not "no WebView2" — `withoutWebView2`
// removes it inside the sandbox first.

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BOM = '\uFEFF'

/**
 * An argument for `powershell -File`, which takes its arguments from the raw command line: double
 * quotes group and are removed, single quotes would stay part of the value. No file name or bundle
 * identifier can hold a double quote.
 */
const argQuote = (s) => {
  if (String(s).includes('"')) throw new Error(`an argument cannot hold a double quote: ${s}`)
  return `"${s}"`
}

/**
 * The command the sandbox runs at logon.
 *
 * @param {object} options
 * @param {string} options.inside      the mapped folder as the sandbox sees it
 * @param {string} options.exe         the app's executable file name
 * @param {string} [options.identifier]
 * @param {string} [options.extra]     a script file name in the mapped folder
 * @param {boolean} [options.withoutWebView2]
 */
export function logonCommand({ inside, exe, identifier, extra, withoutWebView2 = false }) {
  const args = [`-Exe ${argQuote(exe)}`]
  if (identifier) args.push(`-Identifier ${argQuote(identifier)}`)
  if (extra) args.push(`-Extra ${argQuote(extra)}`)
  if (withoutWebView2) args.push('-WithoutWebView2')
  return `powershell -NoProfile -ExecutionPolicy Bypass -File ${inside}\\inside.ps1 ${args.join(' ')}`
}

const xml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** A `.wsb` configuration: networking and GPU off, one folder mapped read-write, a logon command. */
export function wsbConfig({ hostFolder, inside, command }) {
  return `<Configuration>
  <Networking>Disable</Networking>
  <vGPU>Disable</vGPU>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${xml(hostFolder)}</HostFolder>
      <SandboxFolder>${xml(inside)}</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>${xml(command)}</Command>
  </LogonCommand>
</Configuration>
`
}

/**
 * Windows PowerShell 5.1, which the sandbox runs, reads a file without a byte order mark in the
 * ANSI code page: one non-ASCII character inside a string can end it early and the script never
 * starts. The mark makes it read the file as UTF-8.
 */
export function withBom(text) {
  return BOM + text.replace(/^\uFEFF/, '')
}

/** The result file's content, once it parses (the sandbox may still be writing it). */
export function parseResult(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

/** The value a step recorded, by name. */
export const stepValue = (result, name) => result.steps.find((s) => s.name === name)?.value

/**
 * Lines that say what each step saw, and the conclusions a reader would otherwise have to draw.
 *
 * @param {{ ok: boolean, steps: { name: string, ok: boolean, value?: unknown, error?: string }[] }} result
 * @param {{ withoutWebView2?: boolean }} [options]
 */
export function describe(result, { withoutWebView2 = false } = {}) {
  const lines = result.steps.map((step) => {
    const shown = !step.ok ? step.error : typeof step.value === 'object' && step.value !== null ? JSON.stringify(step.value, null, 2) : step.value ?? '(none)'
    return `  ${step.ok ? '·' : '✗'} ${step.name}: ${shown}`
  })
  // Say when the sandbox, not the installer, is what cannot provide a web view.
  if (!withoutWebView2 && /no runtime files/.test(stepValue(result, 'webview2 before') ?? '')) {
    lines.push('  ! this sandbox registers a WebView2 runtime whose files are missing, so no window can start here — run without WebView2')
  }
  const setup = stepValue(result, 'install diagnostics')?.webview2Setup
  if (setup?.length) lines.push(`  ! the WebView2 setup the installer carries failed inside the sandbox:\n    ${setup.join('\n    ')}`)
  return lines
}

/** What must hold for a run to pass, as `[ok, what]` pairs. */
export function verdicts(result, { withoutWebView2 = false } = {}) {
  const checks = [
    [stepValue(result, 'network') === 'offline', 'the sandbox has no network'],
    [result.ok === true, 'every step in the sandbox passed'],
    [Boolean(stepValue(result, 'webview2 after')), 'a WebView2 runtime is registered after the install'],
  ]
  if (withoutWebView2) checks.push([stepValue(result, 'webview2 before') == null, 'the WebView2 runtime was gone before the install'])
  return checks
}

/** Whether a sandbox's virtual machine is running (its memory process is named after it). */
export function sandboxRunning() {
  const list = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout ?? ''
  return /"(vmmemWindowsSandbox|WindowsSandboxServer\.exe)"/i.test(list)
}

/**
 * Starts the sandbox and returns how to close it: the .wsb file is opened the way a person would,
 * and closing means ending the sandbox's processes, which discards it too.
 */
function startSandbox(config) {
  // Only one sandbox runs at a time, and one that is still shutting down keeps the next from
  // running its logon command.
  if (sandboxRunning()) throw new Error('a Windows Sandbox is already running - close it and try again')
  spawn('WindowsSandbox', [config], { detached: true, stdio: 'ignore' }).unref()
  return () => {
    for (const name of ['WindowsSandboxRemoteSession.exe', 'WindowsSandboxServer.exe', 'WindowsSandboxClient.exe', 'WindowsSandbox.exe']) {
      spawnSync('taskkill', ['/F', '/IM', name], { stdio: 'ignore' })
    }
    // The virtual machine outlives those processes by a while; wait for it so the next run starts clean.
    const until = Date.now() + 5 * 60 * 1000
    while (sandboxRunning() && Date.now() < until) spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep 3'])
  }
}

async function waitForResult(file, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const result = existsSync(file) ? parseResult(readFileSync(file, 'utf8')) : undefined
    if (result) return result
    await new Promise((r) => setTimeout(r, 5000))
  }
  throw new Error(`no result from the sandbox within ${timeoutMs / 60000} minutes`)
}

/**
 * Lays out a folder for one run and, unless `prepareOnly`, runs it in Windows Sandbox. Answers
 * `{ folder, config }` when only prepared, else `{ result, lines, failed }` — `failed` lists what
 * did not hold. The folder is removed after a passing run and kept after a failing one.
 *
 * @param {object} options
 * @param {string} options.installer        the installer to check
 * @param {string} options.exe              the app's executable file name once installed
 * @param {string} [options.identifier]     the app's bundle identifier (lists its data folder when the start fails)
 * @param {string} [options.extraScript]    a PowerShell script with the app's own steps (see sandbox/inside.ps1)
 * @param {boolean} [options.withoutWebView2]
 * @param {boolean} [options.prepareOnly]
 * @param {string} [options.inside]         the folder as the sandbox sees it (default C:\tauri-app-check)
 * @param {number} [options.timeoutMs]      default 15 minutes
 */
export async function runInSandbox({ installer, exe, identifier, extraScript, withoutWebView2 = false, prepareOnly = false, inside = 'C:\\tauri-app-check', timeoutMs = 15 * 60 * 1000 }) {
  if (!prepareOnly && spawnSync('where', ['WindowsSandbox'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('Windows Sandbox is not available — turn on the Containers-DisposableClientVM feature and restart')
  }
  if (!existsSync(installer)) throw new Error(`no installer at ${installer}`)
  const folder = await mkdtemp(join(tmpdir(), 'tauri-app-sandbox-'))
  copyFileSync(installer, join(folder, basename(installer)))
  await writeFile(join(folder, 'inside.ps1'), withBom(readFileSync(join(here, 'sandbox', 'inside.ps1'), 'utf8')))
  const extra = extraScript ? basename(extraScript) : undefined
  if (extraScript) await writeFile(join(folder, extra), withBom(readFileSync(extraScript, 'utf8')))
  await mkdir(join(folder, 'out'))
  const config = join(folder, 'check.wsb')
  await writeFile(config, wsbConfig({ hostFolder: folder, inside, command: logonCommand({ inside, exe, identifier, extra, withoutWebView2 }) }))
  if (prepareOnly) return { folder, config }

  const close = startSandbox(config)
  let result
  try {
    result = await waitForResult(join(folder, 'out', 'result.json'), timeoutMs)
  } catch (e) {
    const progress = join(folder, 'out', 'progress.log')
    const log = existsSync(progress) ? `\n${readFileSync(progress, 'utf8').trimEnd()}` : ' (the script inside never started)'
    throw new Error(`${e.message} — the folder is kept: ${folder}; steps seen:${log}`)
  } finally {
    close()
  }
  const failed = verdicts(result, { withoutWebView2 }).filter(([ok]) => !ok).map(([, what]) => what)
  if (failed.length) failed.push(`the folder is kept: ${folder}`)
  else await rm(folder, { recursive: true, force: true })
  return { result, lines: describe(result, { withoutWebView2 }), failed }
}
