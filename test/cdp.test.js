import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { findPage, portAnswers } from '../src/cdp.js'

test('findPage answers the first page a debugging endpoint lists', async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(req.url === '/json/list' ? JSON.stringify([{ type: 'service_worker' }, { type: 'page', id: 'p1' }]) : '{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const { port } = server.address()
  assert.equal((await findPage(port)).id, 'p1')
  assert.equal(await portAnswers(port), true)
})

test('findPage gives up with the reason once its time is out', async () => {
  await assert.rejects(findPage(1, { timeoutMs: 300 }), /no page on debugging port 1/)
  assert.equal(await portAnswers(1), false)
})
