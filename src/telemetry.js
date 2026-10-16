// What a release did once people ran it: for each version, how often it was started, on how many installations, how
// many sessions it left unfinished (it ended without saying so — a crash, a kill, a power cut), and how many failures it
// reported — read from the Application Insights resource tauri-kit-diagnostics sends to, under the names it uses
// (`SessionStart`, `SessionUnfinished`, exception items, the installation as the user, the version as the
// application's). A release's verify step reads it to see the new version arrive and how it fares beside the last one.
//
// Read as the person running it, signed in to the Azure CLI — which gives the resource's application id and an access
// token; the query goes to the Application Insights API. Nothing here holds a key or a connection string.

import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * @typedef {{ version: string, launches: number, installs: number, unfinished: number, exceptions: number }} VersionRow
 */

/** The query: one row per version seen in the last `days` days, the newest first. */
export function telemetryQuery(days) {
  if (!Number.isInteger(days) || days < 1) throw new Error(`days must be a whole number of days — got ${days}`)
  return [
    'union customEvents, exceptions',
    `| where timestamp > ago(${days}d)`,
    "| extend start = itemType == 'customEvent' and name == 'SessionStart'",
    '| summarize',
    '    launches = countif(start),',
    '    installs = dcountif(user_Id, start),',
    "    unfinished = countif(itemType == 'customEvent' and name == 'SessionUnfinished'),",
    "    exceptions = countif(itemType == 'exception'),",
    '    seen = max(timestamp)',
    '    by version = application_Version',
    '| order by seen desc',
    '| project version, launches, installs, unfinished, exceptions',
  ].join('\n')
}

/** The rows of the first table an Application Insights query answered, as objects by column name. */
export function tableRows(answer) {
  const table = answer?.tables?.[0]
  if (!table) throw new Error('the query answered no table')
  const names = table.columns.map((c) => c.name)
  return table.rows.map((row) => Object.fromEntries(names.map((name, i) => [name, row[i]])))
}

/** Each version's counts, from the answer to `telemetryQuery`. @returns {VersionRow[]} */
export function versionRows(answer) {
  return tableRows(answer).map((r) => ({
    version: r.version || '(none)',
    launches: Number(r.launches),
    installs: Number(r.installs),
    unfinished: Number(r.unfinished),
    exceptions: Number(r.exceptions),
  }))
}

/**
 * The Azure CLI, given only plain words: on Windows it is a batch file, which Node starts only through a shell — and a
 * query of several lines would not survive one, so the CLI is asked for short things alone (an id, a token) and the
 * query goes to the service directly.
 */
async function az(args) {
  for (const a of args) if (!/^[\w.:/@-]+$/.test(a)) throw new Error(`not a plain word for the Azure CLI: "${a}"`)
  // Through a shell on Windows as one line of plain words, which nothing there can read as anything else.
  const { stdout } =
    process.platform === 'win32'
      ? await promisify(exec)(['az', ...args].join(' '), { encoding: 'utf8' })
      : await promisify(execFile)('az', args, { encoding: 'utf8' })
  return stdout.trim()
}

/**
 * Asks the resource `app` in `resourceGroup` for each version's counts over the last `days` days: its application id
 * and an access token from the Azure CLI, signed in as the person running it, then the query to the Application
 * Insights API.
 *
 * @param {{ app: string, resourceGroup: string, days?: number, cli?: (args: string[]) => Promise<string>, fetchImpl?: typeof fetch }} options
 */
export async function readTelemetry({ app, resourceGroup, days = 7, cli = az, fetchImpl = fetch }) {
  const query = telemetryQuery(days)
  let appId, token
  try {
    appId = await cli(['monitor', 'app-insights', 'component', 'show', '--app', app, '--resource-group', resourceGroup, '--query', 'appId', '-o', 'tsv'])
    token = await cli(['account', 'get-access-token', '--resource', 'https://api.applicationinsights.io', '--query', 'accessToken', '-o', 'tsv'])
  } catch (e) {
    const said = String(e.stderr ?? e.message).trim().split(/\r?\n/).at(-1)
    throw new Error(`the Azure CLI could not reach ${app}: ${said}${/az login/i.test(said) ? '' : ' (signed in with `az login`?)'}`)
  }
  const res = await fetchImpl(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Application Insights answered ${res.status} for ${app}: ${(await res.text()).slice(0, 200)}`)
  return versionRows(await res.json())
}

/** The rows as a table to read, a version per line. @param {VersionRow[]} rows */
export function formatTelemetry(rows) {
  const head = ['version', 'launches', 'installs', 'unfinished', 'exceptions']
  const cells = [head, ...rows.map((r) => [r.version, r.launches, r.installs, r.unfinished, r.exceptions].map(String))]
  const widths = head.map((_, i) => Math.max(...cells.map((c) => c[i].length)))
  return cells.map((c) => '  ' + c.map((v, i) => (i === 0 ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join('  ')).join('\n')
}
