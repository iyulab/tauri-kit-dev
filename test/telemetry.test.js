import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTelemetry, readTelemetry, telemetryQuery, versionRows } from '../src/telemetry.js'

/** What `az monitor app-insights query -o json` answers. */
const ANSWER = {
  tables: [
    {
      name: 'PrimaryResult',
      columns: [
        { name: 'version', type: 'string' },
        { name: 'launches', type: 'long' },
        { name: 'installs', type: 'long' },
        { name: 'unfinished', type: 'long' },
        { name: 'exceptions', type: 'long' },
      ],
      rows: [
        ['0.3.0', 12, 4, 1, 2],
        ['0.2.0', 40, 9, 0, 5],
        ['', 0, 0, 0, 1],
      ],
    },
  ],
}

test('the query counts what tauri-kit-diagnostics sends, per version, over the days asked', () => {
  const query = telemetryQuery(14)
  assert.match(query, /ago\(14d\)/)
  assert.match(query, /name == 'SessionStart'/)
  assert.match(query, /name == 'SessionUnfinished'/)
  assert.match(query, /itemType == 'exception'/)
  assert.match(query, /dcountif\(user_Id, start\)/)
  assert.match(query, /by version = application_Version/)
  assert.throws(() => telemetryQuery(0), /whole number of days/)
})

test('each version’s counts are read from the answer, a version left unsaid named as none', () => {
  assert.deepEqual(versionRows(ANSWER), [
    { version: '0.3.0', launches: 12, installs: 4, unfinished: 1, exceptions: 2 },
    { version: '0.2.0', launches: 40, installs: 9, unfinished: 0, exceptions: 5 },
    { version: '(none)', launches: 0, installs: 0, unfinished: 0, exceptions: 1 },
  ])
  assert.throws(() => versionRows({ tables: [] }), /no table/)
})

test('asks the Azure CLI for the resource’s id and a token, the service for the query, and says what it could not reach', async () => {
  const asked = []
  const sent = []
  const rows = await readTelemetry({
    app: 'notes-insights',
    resourceGroup: 'notes',
    days: 3,
    cli: async (args) => {
      asked.push(args)
      return args[0] === 'account' ? 'token-1' : 'app-id-1'
    },
    fetchImpl: async (url, init) => {
      sent.push({ url, init })
      return { ok: true, json: async () => ANSWER }
    },
  })
  assert.equal(rows[0].version, '0.3.0')
  assert.deepEqual(asked[0].slice(0, 8), ['monitor', 'app-insights', 'component', 'show', '--app', 'notes-insights', '--resource-group', 'notes'])
  assert.equal(sent[0].url, 'https://api.applicationinsights.io/v1/apps/app-id-1/query')
  assert.equal(sent[0].init.headers.authorization, 'Bearer token-1')
  assert.match(JSON.parse(sent[0].init.body).query, /ago\(3d\)/)
  await assert.rejects(
    readTelemetry({ app: 'x', resourceGroup: 'y', cli: async () => Promise.reject(Object.assign(new Error('failed'), { stderr: 'ERROR: Please run az login' })) }),
    /could not reach x: ERROR: Please run az login$/,
  )
  await assert.rejects(
    readTelemetry({ app: 'x', resourceGroup: 'y', cli: async () => 'id', fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }) }),
    /answered 403 for x: Forbidden/,
  )
})

test('the rows print as a table, numbers to the right', () => {
  assert.equal(
    formatTelemetry(versionRows(ANSWER).slice(0, 2)),
    ['  version  launches  installs  unfinished  exceptions', '  0.3.0          12         4           1           2', '  0.2.0          40         9           0           5'].join('\n'),
  )
})
