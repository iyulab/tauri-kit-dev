#!/usr/bin/env node
// tauri-kit-dev <command> [options]
//
//   public-text [--config <file>] [--history] [<repo>...]
//       Checks git repositories (default: the current one) for text a public repository must not
//       carry. --config names a module exporting { forbidden, allowed, defaults, binary } — see
//       src/public-text.js. --history also reads every commit, every line ever added and tag
//       messages. Exits 1 when anything is found.

import { relative } from 'node:path'
import { parseArgs } from '../src/args.js'
import { checkRepo, loadConfig } from '../src/public-text.js'

const USAGE = 'usage: tauri-kit-dev public-text [--config <file>] [--history] [<repo>...]'

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

const commands = { 'public-text': publicText }

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
