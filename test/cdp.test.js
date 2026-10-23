import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Cdp, findPage, portAnswers } from '../src/cdp.js'

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

/** A debugging endpoint that takes the connection and never answers a command — a page that hangs. */
async function silentEndpoint(t) {
  const { createHash } = await import('node:crypto')
  const server = createServer()
  const sockets = new Set()
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('error', () => {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  return `ws://127.0.0.1:${server.address().port}/`
}

test('waitFor fails at its deadline even when an evaluation never answers', async (t) => {
  const cdp = await Cdp.connect(await silentEndpoint(t))
  t.after(() => cdp.close())
  const started = Date.now()
  await assert.rejects(cdp.waitFor('true', 'the window', { timeoutMs: 300 }), /timed out waiting for the window \(Runtime\.evaluate: no answer within/)
  assert.ok(Date.now() - started < 2000)
})

test('a command given a time fails once it is out; one given none keeps waiting', async (t) => {
  const cdp = await Cdp.connect(await silentEndpoint(t))
  t.after(() => cdp.close())
  await assert.rejects(cdp.send('Page.enable', {}, { timeoutMs: 100 }), /Page\.enable: no answer within 0\.1 s/)
  const pending = cdp.send('Page.enable')
  const settled = await Promise.race([pending.then(() => 'answered', () => 'failed'), new Promise((r) => setTimeout(() => r('waiting'), 200))])
  assert.equal(settled, 'waiting')
  cdp.close()
  await assert.rejects(pending, /Page\.enable: the window's debugging connection closed/)
})

/** A debugging endpoint that sends `events` (CDP event messages) as soon as the connection is made. */
async function speakingEndpoint(t, events) {
  const { createHash } = await import('node:crypto')
  const server = createServer()
  const sockets = new Set()
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('error', () => {})
    for (const event of events) {
      const payload = Buffer.from(JSON.stringify(event))
      // An unmasked text frame, as a server sends it (payloads here stay under 126 bytes).
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  return `ws://127.0.0.1:${server.address().port}/`
}

test('on hears the events of its method until it is stopped', async (t) => {
  const heard = []
  const url = await speakingEndpoint(t, [
    { method: 'Log.entryAdded', params: { entry: { level: 'error', text: 'one' } } },
    { method: 'Page.loadEventFired', params: {} },
    { method: 'Log.entryAdded', params: { entry: { level: 'warning', text: 'two' } } },
  ])
  // Listening starts before the frames are read: they arrive on the connection's first turns of the event loop.
  const cdp = await Cdp.connect(url)
  t.after(() => cdp.close())
  const stop = cdp.on('Log.entryAdded', ({ entry }) => heard.push(entry.text))
  await new Promise((r) => setTimeout(r, 200))
  stop()
  assert.deepEqual(heard, ['one', 'two'])
})
