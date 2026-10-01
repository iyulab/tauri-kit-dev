// What a Windows machine needs to build and check a Tauri app and does not always have, checked
// up front so a run does not fail twenty minutes in with a message that points elsewhere.

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'

/** Runs a command and answers what it printed, or undefined when it could not run. */
function output(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/**
 * The problem with the active Rust toolchain, if any: a Tauri app links as a cdylib, which the GNU
 * linker on Windows fails at without saying why.
 *
 * @param {string | undefined} activeToolchain  what `rustup show active-toolchain` printed
 */
export function toolchainProblem(activeToolchain) {
  if (!activeToolchain || activeToolchain.includes('msvc')) return undefined
  return `Rust uses ${activeToolchain.split(/\s/)[0]}; Tauri needs MSVC: rustup override set stable-x86_64-pc-windows-msvc`
}

/**
 * Where DOTNET_ROOT should point, if it needs setting: a .NET helper built as an apphost finds the
 * runtime through DOTNET_ROOT or a machine-wide install, so a per-user install needs it.
 *
 * @param {string | undefined} dotnetOnPath  the real path of the dotnet executable on PATH
 */
export function dotnetRootFor(dotnetOnPath) {
  if (!dotnetOnPath) return undefined
  const root = dirname(dotnetOnPath)
  return /program files/i.test(root) ? undefined : root
}

/**
 * Checks this machine. Answers the problems found and the environment variables to add (only ever
 * ones that were unset).
 *
 * @param {{ dotnet?: boolean, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 *        dotnet: the app bundles a .NET helper process
 */
export function checkMachine({ dotnet = false, env = process.env, platform = process.platform } = {}) {
  const problems = []
  const set = {}
  if (platform === 'win32') {
    const toolchain = toolchainProblem(output('rustup', ['show', 'active-toolchain']))
    if (toolchain) problems.push(toolchain)
  }
  if (dotnet) {
    if (!output('dotnet', ['--version'])) problems.push('no dotnet on PATH (install the SDK global.json names)')
    else if (platform === 'win32' && !env.DOTNET_ROOT) {
      const where = output('where', ['dotnet'])?.split(/\r?\n/)[0]
      const root = dotnetRootFor(where ? realpathSync(where) : undefined)
      if (root) set.DOTNET_ROOT = root
    }
  }
  return { problems, set }
}
