import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('activity resolution separates domain misses from unavailable infrastructure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sekaisync-alias-test-'))
  mkdirSync(join(root, 'kb'))
  writeFileSync(join(root, 'kb', 'sekaisync.db'), 'fixture')
  const localMap = {
    characters: {
      1: {
        aliases: ['fixture'], unit: 'fixture-unit', names: { ja: 'Fixture' },
        box_events: [{ ordinal: 1, regions: { jp: { event_id: 7, name: 'Fixture official event' } } }],
      },
    },
  }
  writeFileSync(join(root, 'sekaisync.py'), `print(${JSON.stringify(JSON.stringify(localMap))})\n`)
  let mode = 'unavailable'
  let started
  const visits = []
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') { res.end('{"status":"ok","ready":true}'); return }
    const url = new URL(req.url, 'http://127.0.0.1')
    const method = url.pathname.split('/').at(-1)
    const query = url.searchParams.get('query')
    visits.push({ method, query })
    const send = (value) => res.end(JSON.stringify(value))
    const fail = (code = 503) => { res.writeHead(code); res.end('fixture unavailable') }
    if (mode === 'hold') { started?.(); return }
    if (mode === 'activity-match' && method === 'activity') {
      send({ kind: 'wl', query, round: 3, events: [] }); return
    }
    if (mode === 'old-server') {
      if (method === 'activity') fail(404)
      else send({ query, mapping: { jp: { event_id: 1 } } })
      return
    }
    if (mode === 'activity-miss' && method === 'activity') { send({ kind: 'unresolved', query }); return }
    if (mode === 'legacy-miss' && method === 'event_alias') { send(null); return }
    if (mode === 'empty-response' && method === 'activity') { send({ query, results: [] }); return }
    if (mode === 'candidate-miss' && query === 'khn3' && method === 'activity') { send({ kind: 'unresolved' }); return }
    if (mode === 'invalid-json' && method === 'activity') { res.end('{bad json'); return }
    fail()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const keys = ['SEKAISYNC_STORE', 'SEKAISYNC_ROOT', 'SEKAISYNC_PORT', 'SEKAISYNC_PYTHON']
  const oldEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, { SEKAISYNC_STORE: root, SEKAISYNC_ROOT: root, SEKAISYNC_PORT: String(server.address().port), SEKAISYNC_PYTHON: process.execPath })
  const api = await import('../lib/backend.js?alias-errors')
  t.after(async () => {
    api.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(root, { recursive: true, force: true })
  })
  function reset(nextMode, python = process.execPath) {
    api.dispose()
    mode = nextMode
    process.env.SEKAISYNC_PYTHON = python
    visits.length = 0
  }
  await t.test('all sources unavailable throw rather than invent a domain miss', async () => {
    reset('unavailable')
    await assert.rejects(api.resolveAlias('khn3', 'jp'), (error) => {
      assert.match(error.message, /Activity resolution unavailable/)
      assert.match(error.message, /activity: HTTP 503/)
      assert.match(error.message, /event_alias: HTTP 503/)
      assert.ok(error.cause)
      assert.deepEqual(Object.keys(error.endpoint_errors), ['alias_index', 'activity', 'event_alias'])
      return true
    })
  })
  await t.test('healthy modern API match survives unavailable local CLI', async () => {
    reset('activity-match')
    const result = await api.resolveAlias('wl3', 'jp')
    assert.equal(result.kind, 'wl')
    assert.equal(result.round, 3)
    assert.deepEqual(visits.map((value) => value.method), ['activity'])
  })
  await t.test('old-server activity 404 falls back to event_alias', async () => {
    reset('old-server')
    const result = await api.resolveAlias('khn3', 'jp')
    assert.equal(result.kind, 'box')
    assert.equal(result.mapping.jp.event_id, 1)
    assert.deepEqual(visits.map((value) => value.method), ['activity', 'event_alias'])
  })
  for (const nextMode of ['activity-miss', 'legacy-miss', 'empty-response']) {
    await t.test(`${nextMode} stays domain null despite other source failures`, async () => {
      reset(nextMode)
      assert.equal(await api.resolveAlias('khn3', 'jp'), null)
    })
  }
  await t.test('one successful extracted candidate preserves a domain miss', async () => {
    reset('candidate-miss')
    assert.equal(await api.resolveAlias('khn3 box event', 'jp'), null)
    assert.ok(visits.some((value) => value.query === 'khn3'))
    assert.ok(visits.some((value) => value.query !== 'khn3'))
  })
  await t.test('malformed JSON is an infrastructure error, not a healthy miss', async () => {
    reset('invalid-json')
    await assert.rejects(api.resolveAlias('khn3', 'jp'), /unavailable/)
  })
  await t.test('pre-aborted caller never probes an endpoint', async () => {
    reset('unavailable')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(api.resolveAlias('khn3', 'jp', 1000, controller.signal), /\u5df2\u53d6\u6d88/)
    assert.equal(visits.length, 0)
  })
  await t.test('in-flight cancellation is never converted into domain null', async () => {
    reset('hold')
    const controller = new AbortController()
    const hasStarted = new Promise((resolve) => { started = resolve })
    const pending = api.resolveAlias('khn3', 'jp', 1000, controller.signal)
    await hasStarted
    controller.abort()
    await assert.rejects(pending, /\u5df2\u53d6\u6d88/)
  })
  const python = process.env.SEKAISYNC_TEST_PYTHON || 'python'
  const pythonProbe = spawnSync(python, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 3000 })
  const pythonSkip = pythonProbe.status !== 0 ? 'Python unavailable; set SEKAISYNC_TEST_PYTHON to run local-index fixtures' : false
  await t.test('usable local index resolves official names with both HTTP endpoints unavailable', { skip: pythonSkip }, async () => {
    reset('unavailable', python)
    const result = await api.resolveAlias('Fixture official event', 'jp')
    assert.equal(result.kind, 'box')
    assert.equal(result.matchedBy, 'official_name')
    assert.equal(result.mapping.jp.event_id, 7)
  })
  await t.test('usable local index keeps genuine local misses as domain null', { skip: pythonSkip }, async () => {
    reset('unavailable', python)
    assert.equal(await api.resolveAlias('not an official activity name', 'jp'), null)
  })
})
