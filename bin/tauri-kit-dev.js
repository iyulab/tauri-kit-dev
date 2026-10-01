#!/usr/bin/env node
// tauri-kit-dev <command> [options]
//
//   gate --config <file> [--list] [--only a,b] [--skip c] [--<flag>]
//       Runs an app's checks in order, every one even after one fails, and ends with a summary.
//       --config names a module exporting { steps, preflight? } — see src/gate.js. Steps that opt
//       in with a flag run only when it is given. Exits 1 when a step failed, 2 when it did not
//       start.
//
//   public-text [--config <file>] [--history] [<repo>...]
//       Checks git repositories (default: the current one) for text a public repository must not
//       carry. --config names a module exporting { forbidden, allowed, defaults, binary } — see
//       src/public-text.js. --history also reads every commit, every line ever added and tag
//       messages. Exits 1 when anything is found.
//
//   machine [--dotnet]
//       Checks this machine for what a Tauri build needs (on Windows: the MSVC Rust toolchain);
//       --dotnet for an app that bundles a .NET helper (dotnet on PATH, DOTNET_ROOT for a per-user
//       install). Exits 1 when something is missing.
//
//   sandbox <installer> --exe <file> [--identifier <id>] [--extra <script>] [--without-webview2] [--prepare]
//       Installs and starts the app in Windows Sandbox with networking off. --prepare only lays out
//       the folder and the .wsb file. Exits 1 when the run did not pass.

import { relative } from 'node:path'
import { parseArgs } from '../src/args.js'
import { loadGateConfig, runGate } from '../src/gate.js'
import { checkMachine } from '../src/machine.js'
import { checkRepo, loadConfig } from '../src/public-text.js'
import { runInSandbox } from '../src/sandbox.js'

const USAGE = `usage: tauri-kit-dev gate --config <file> [--list] [--only a,b] [--skip c] [--<flag>]
       tauri-kit-dev public-text [--config <file>] [--history] [<repo>...]
       tauri-kit-dev machine [--dotnet]
       tauri-kit-dev sandbox <installer> --exe <file> [--identifier <id>] [--extra <script>] [--without-webview2] [--prepare]`

async function gate(argv) {
  const at = argv.indexOf('--config')
  if (at === -1 || at + 1 >= argv.length) throw new Error(`gate needs --config <file>
${USAGE}`)
  const config = await loadGateConfig(argv[at + 1])
  return runGate({ ...config, argv: argv.filter((_, i) => i !== at && i !== at + 1) })
}

async function publicText(argv) {
  const args = parseArgs(argv, { flags: ['--history'], options: ['--config'] })
  const config = args.options['--config'] ? await loadConfig(args.options['--config']) : {}
  const history = args.flags.has('--history')
  const repos = args.positional.length ? args.positional : ['.']
  let total = 0
  for (const repo of repos) {
    const findings = checkRepo(repo, { config, history })
    total += findings.length
    const name = relative(process.cwd(), repo) || '.'
    for (const f of findings) console.error(`${name}${f.where.startsWith('@') || f.where.startsWith('#') ? '' : '/'}${f.where}: ${f.why} — ${f.text.slice(0, 160)}`)
  }
  if (total) {
    console.error(`\n${total} finding(s) in public text.`)
    return 1
  }
  console.log(`public text clean — ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}${history ? ', full history' : ''}.`)
  return 0
}

async function machine(argv) {
  const args = parseArgs(argv, { flags: ['--dotnet'] })
  const { problems, set } = checkMachine({ dotnet: args.flags.has('--dotnet') })
  for (const [name, value] of Object.entries(set)) console.log(`${name} is not set; the build needs ${name}=${value} (the dotnet on PATH)`)
  for (const p of problems) console.error(`✗ ${p}`)
  if (problems.length || Object.keys(set).length) return 1
  console.log('this machine has what the build needs')
  return 0
}

async function sandbox(argv) {
  const args = parseArgs(argv, { flags: ['--without-webview2', '--prepare'], options: ['--exe', '--identifier', '--extra'] })
  const [installer] = args.positional
  if (!installer || !args.options['--exe']) throw new Error(`an installer and --exe are required\n${USAGE}`)
  const withoutWebView2 = args.flags.has('--without-webview2')
  const run = await runInSandbox({
    installer,
    exe: args.options['--exe'],
    identifier: args.options['--identifier'],
    extraScript: args.options['--extra'],
    withoutWebView2,
    prepareOnly: args.flags.has('--prepare'),
  })
  if (run.config) {
    console.log(`  · prepared ${run.folder} — open ${run.config} to run it by hand; the result lands in out\\result.json`)
    return 0
  }
  for (const line of run.lines) console.log(line)
  if (run.failed.length) {
    for (const f of run.failed) console.error(`✗ ${f}`)
    return 1
  }
  console.log(run.result.steps.find((s) => s.name === 'webview2 before')?.value
    ? '  ✓ installed and started without a network (WebView2 was already there — this does not show an install onto a computer without it)'
    : '  ✓ installed and started without a network, with the WebView2 runtime from the installer')
  return 0
}

const commands = { gate, 'public-text': publicText, machine, sandbox }

async function main([command, ...rest]) {
  const run = commands[command]
  if (!run) {
    console.error(command ? `unknown command: ${command}\n${USAGE}` : USAGE)
    return 2
  }
  try {
    return await run(rest)
  } catch (e) {
    console.error(`✗ ${e.message}`)
    return 2
  }
}

process.exitCode = await main(process.argv.slice(2))
