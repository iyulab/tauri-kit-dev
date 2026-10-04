#!/usr/bin/env node
// tauri-kit-dev <command> [options]
//
//   gate --config <file> [--list] [--only a,b] [--skip c] [--<flag>]
//       Runs an app's checks in order, every one even after one fails, and ends with a summary.
//       --config names a module exporting { steps, preflight? } — see src/gate.js. Steps that opt
//       in with a flag run only when it is given. Exits 1 when a step failed, 2 when it did not
//       start.
//
//   pin-drift --props <file> --project <file> --publisher <name> [--properties <Name=Value;…>] [--max-minor-gap <n>] [--waivers <file>]
//       Checks the NuGet pins of one publisher's packages in a Directory.Packages.props against
//       nuget.org: a major difference, or more minor versions behind than allowed (default 5),
//       fails unless a waiver with an unexpired date covers it. --project is the .NET project whose
//       restored graph says which packages are used (restored first, with --properties as MSBuild
//       properties — the ones the app is published with, such as RuntimeIdentifier=win-x64); --waivers
//       a JSON list of { package, until, reason }. Exits 1 on drift.
//
//   notices --config <file> [--strict] [--check]
//       Writes an app's third-party notices: every package its package managers say it ships, with
//       the license texts each carries or the one pinned for it. --config names a module exporting
//       { out, title?, render?, npm?, cargo?, nuget?, pinned? } — see shippedNotices in
//       src/notices.js; paths in it are relative to the module's folder, nuget is { project,
//       properties? } (the MSBuild properties the helper is published with), and render(packages)
//       returns the document when noticesText's is not the one wanted. --strict also fails on a
//       package left without a license text (for a public release); --check writes nothing and
//       fails when the file is not what would be written. Exits 1 on a failure.
//
//   notice-pins (--config <file> | --pins <file> --dir <dir>)
//       Downloads the pinned license texts (see applyPinned in src/notices.js) into --dir. A pin
//       given only its source gets the SHA-256 of what was downloaded, written back to --pins; a
//       pinned text whose source no longer matches its SHA-256 is an error. With --config (the
//       notices config), first looks up a pin for every shipped package still without a text — its
//       license file at the commit or tag it was published from (see suggestPins) — adds those to
//       the config's pins, and names the packages it found nothing for. Exits 2 on an error.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { parseArgs } from '../src/args.js'
import { loadGateConfig, runGate } from '../src/gate.js'
import { fetchPinned, noticesText, shippedNotices, suggestPins, writeOrCheck } from '../src/notices.js'
import { checkPinDrift, formatLine } from '../src/pin-drift.js'
import { checkMachine } from '../src/machine.js'
import { checkRepo, loadConfig } from '../src/public-text.js'
import { runInSandbox } from '../src/sandbox.js'

const USAGE = `usage: tauri-kit-dev gate --config <file> [--list] [--only a,b] [--skip c] [--<flag>]
       tauri-kit-dev pin-drift --props <file> --project <file> --publisher <name> [--properties <Name=Value;…>] [--max-minor-gap <n>] [--waivers <file>]
       tauri-kit-dev notices --config <file> [--strict] [--check]
       tauri-kit-dev notice-pins (--config <file> | --pins <file> --dir <dir>)
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

async function pinDrift(argv) {
  const args = parseArgs(argv, { options: ['--props', '--project', '--publisher', '--properties', '--max-minor-gap', '--waivers'] })
  const { '--props': props, '--project': project, '--publisher': publisher } = args.options
  if (!props || !project || !publisher) throw new Error(`--props, --project and --publisher are required
${USAGE}`)
  const gapText = args.options['--max-minor-gap']
  const maxMinorGap = gapText === undefined ? 5 : Number.parseInt(gapText, 10)
  if (!Number.isInteger(maxMinorGap) || maxMinorGap < 0) throw new Error(`--max-minor-gap must be a whole number — got "${gapText}"`)
  const waiversFile = args.options['--waivers']
  const waivers = waiversFile ? JSON.parse(readFileSync(waiversFile, 'utf8')) : []
  const properties = msbuildProperties(args.options['--properties'])
  const report = await checkPinDrift({ props, project, properties, publisher, maxMinorGap, waivers })
  for (const line of report.lines) console.log(formatLine(line))
  if (report.failures) {
    console.error(`
${report.failures} package(s) drifted past the threshold (major difference or more than ${maxMinorGap} minor versions).`)
    console.error(`Upgrade them, or add a waiver with an expiry and a reason${waiversFile ? ` to ${waiversFile}` : ' (--waivers)'}.`)
    return 1
  }
  console.log(`
Pin drift within threshold: ${report.pinned} pinned, ${report.transitive} transitive.`)
  return 0
}

/** `Name=Value;Name=Value`, the way MSBuild's own `-p:` takes a list. */
function msbuildProperties(text) {
  const properties = {}
  for (const pair of (text ?? '').split(';').filter((p) => p.trim())) {
    const at = pair.indexOf('=')
    if (at <= 0) throw new Error(`--properties takes Name=Value pairs separated by ";" — got "${pair}"`)
    properties[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
  }
  return properties
}

/** The project a notices config's `nuget` names — `assets` is no longer read: it can be stale. */
function nugetProject(file, nuget) {
  if (nuget.project) return nuget.project
  throw new Error(`${file}: nuget needs { project } — the .NET project file, which notices restores itself (nuget.assets is no longer read)`)
}

/** A notices config with its paths resolved against its own folder. */
async function noticeSources(file) {
  const config = await loadConfig(file)
  const at = (path) => resolve(dirname(resolve(file)), path)
  return {
    config,
    at,
    sources: {
      npm: config.npm && { ...config.npm, lock: at(config.npm.lock), installedAt: config.npm.installedAt && at(config.npm.installedAt) },
      cargo: config.cargo && { ...config.cargo, cwd: at(config.cargo.cwd) },
      nuget: config.nuget && { project: at(nugetProject(file, config.nuget)), properties: config.nuget.properties },
      pinned: config.pinned && {
        pins: typeof config.pinned.pins === 'string' ? at(config.pinned.pins) : config.pinned.pins,
        dir: at(config.pinned.dir),
      },
    },
  }
}

async function notices(argv) {
  const args = parseArgs(argv, { flags: ['--strict', '--check'], options: ['--config'] })
  const file = args.options['--config']
  if (!file) throw new Error(`notices needs --config <file>
${USAGE}`)
  const { config, at, sources } = await noticeSources(file)
  if (!config.out) throw new Error(`${file} does not export { out }`)
  const strict = args.flags.has('--strict')
  const { packages, missing, failures } = shippedNotices({ ...sources, strict })
  const out = at(config.out)
  const body = config.render ? config.render(packages) : noticesText(packages, { title: config.title })
  const check = args.flags.has('--check')
  if (!check) mkdirSync(dirname(out), { recursive: true })
  const current = writeOrCheck(out, body, { check })
  console.log(`notices: ${packages.length} packages, ${missing.length} without a license text → ${out}`)
  if (!strict) for (const p of missing) console.warn(`  without a license text: ${p.name} ${p.version}`)
  if (!current) failures.push(`${out} is not what would be written — run without --check`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  return failures.length ? 1 : 0
}

async function noticePins(argv) {
  const args = parseArgs(argv, { options: ['--pins', '--dir', '--config'] })
  let { '--pins': pins, '--dir': dir } = args.options
  const file = args.options['--config']
  if (file) {
    // Look up a pin for every shipped package still without a text, add what was found, then fetch.
    const { sources } = await noticeSources(file)
    if (!sources.pinned || typeof sources.pinned.pins !== 'string') throw new Error(`${file} needs { pinned: { pins: '<file>', dir } }`)
    ;({ pins, dir } = sources.pinned)
    const { packages } = shippedNotices(sources)
    const table = existsSync(pins) ? JSON.parse(readFileSync(pins, 'utf8')) : {}
    const { pins: found, unresolved } = await suggestPins(packages, { pinned: Object.keys(table) })
    if (Object.keys(found).length) writeFileSync(pins, `${JSON.stringify({ ...table, ...found }, null, 2)}\n`)
    for (const [key, { source }] of Object.entries(found)) console.log(`  ? ${key} → ${source}`)
    for (const key of unresolved) console.warn(`  ✗ ${key}: no license file found at its version — pin it by hand`)
    if (Object.keys(found).length) console.log(`${Object.keys(found).length} pin(s) added to ${pins} — read the texts before committing them.`)
  }
  if (!pins || !dir) throw new Error(`notice-pins needs --config <file>, or --pins and --dir
${USAGE}`)
  const { fetched, pinned } = await fetchPinned({ pins, dir })
  for (const source of pinned) console.log(`  + ${source} pinned`)
  console.log(`${fetched.length} pinned text(s) fetched into ${dir}.`)
  return 0
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

const commands = { gate, notices, 'notice-pins': noticePins, 'pin-drift': pinDrift, 'public-text': publicText, machine, sandbox }

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
