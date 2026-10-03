import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('status distinguishes supplemental failures from missing core data and cancellation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sekaisync-status-test-'))
  mkdirSync(join(root, 'kb'))
  writeFileSync(join(root, 'kb', 'sekaisync.db'), 'fixture')
  const payloads = {
    freshness: { ready: true, updated_at: '2026-10-03', regions: { jp: { language: 'ja' } } },
    progress: { overall: { pct: 80, fact: { pct: 100 }, text: { pct: 60 } } },
    data_gaps: { gaps: [{ key: 'missing-body' }] },
  }
  let failures = new Set()
  let invalid = new Set()
  let hold = false
  let startAll
  let started = new Set()
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') { res.end('{"status":"ok","ready":true}'); return }
    const method = req.url.split('/').at(-1)
    if (hold) {
      started.add(method)
      if (started.size === 3) startAll?.()
      return
    }
    if (failures.has(method)) { res.writeHead(503); res.end(`unavailable: ${method}`); return }
    res.end(JSON.stringify(invalid.has(method) ? null : payloads[method]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const keys = ['SEKAISYNC_STORE', 'SEKAISYNC_ROOT', 'SEKAISYNC_PORT', 'SEKAISYNC_PYTHON']
  const oldEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, { SEKAISYNC_STORE: root, SEKAISYNC_ROOT: root, SEKAISYNC_PORT: String(server.address().port), SEKAISYNC_PYTHON: process.execPath })
  const api = await import('../lib/backend.js?status-errors')
  t.after(async () => {
    api.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(root, { recursive: true, force: true })
  })

  function reset(failed = [], bad = []) {
    api.dispose()
    failures = new Set(failed)
    invalid = new Set(bad)
    hold = false
    started = new Set()
  }
  await t.test('all endpoints available retains normal status output', async () => {
    reset()
    const result = await api.status()
    assert.deepEqual(result.data, payloads.freshness)
    assert.deepEqual(result.progress, payloads.progress)
    assert.deepEqual(result.gaps, payloads.data_gaps)
    assert.equal(result.partial, false)
    assert.deepEqual(result.endpoint_errors, {})
    const output = api.compactStatus(result.data, result.meta, result.progress, result.gaps, result.endpoint_errors)
    assert.match(output, /ready=true/)
    assert.match(output, /coverage: fact=100% text=60% overall=80%/)
    assert.match(output, /known data gaps: 1/)
    assert.doesNotMatch(output, /partial|unavailable/)
  })
  for (const methods of [['progress'], ['data_gaps'], ['progress', 'data_gaps']]) {
    await t.test(`partial status reports failed ${methods.join(', ')} endpoints`, async () => {
      reset(methods)
      const result = await api.status()
      assert.equal(result.partial, true)
      assert.deepEqual(Object.keys(result.endpoint_errors), methods)
      assert.deepEqual(result.data, payloads.freshness)
      for (const method of methods) {
        assert.equal(result[method === 'data_gaps' ? 'gaps' : method], null)
        assert.match(result.endpoint_errors[method].message, /HTTP 503/)
      }
      const output = api.compactStatus(result.data, result.meta, result.progress, result.gaps, result.endpoint_errors)
      assert.match(output, /^status=partial/)
      assert.match(output, /ready=true/)
      for (const method of methods) assert.ok(output.includes(`/${method}: Error: HTTP 503`))
    })
  }
  for (const methods of [['freshness'], ['freshness', 'progress', 'data_gaps']]) {
    await t.test(`missing core ${methods.join(', ')} throws useful endpoint diagnostics`, async () => {
      reset(methods)
      await assert.rejects(api.status(), (error) => {
        assert.match(error.message, /\/freshness.*503/)
        assert.match(error.cause.message, /HTTP 503/)
        assert.deepEqual(Object.keys(error.endpoint_errors), methods)
        return true
      })
    })
  }
  await t.test('null payloads are failures rather than normal readiness', async () => {
    reset([], ['progress'])
    const result = await api.status()
    assert.equal(result.partial, true)
    assert.match(result.endpoint_errors.progress.message, /invalid status payload/)
    reset([], ['freshness'])
    await assert.rejects(api.status(), /\/freshness.*invalid status payload/)
  })
  await t.test('pre-aborted caller throws without calling endpoints', async () => {
    reset()
    const controller = new AbortController()
    controller.abort(new Error('status caller cancelled'))
    await assert.rejects(api.status({ signal: controller.signal }), /status caller cancelled/)
  })
  await t.test('cancellation with all endpoints in flight is not partial success', async () => {
    reset()
    hold = true
    const controller = new AbortController()
    const allStarted = new Promise((resolve) => { startAll = resolve })
    const pending = api.status({ signal: controller.signal })
    await allStarted
    controller.abort(new Error('status in-flight cancelled'))
    await assert.rejects(pending, /status in-flight cancelled/)
    assert.equal(started.size, 3)
  })
  await t.test('bounded error metadata precedes long status fields', () => {
    const meta = { external: true, port: 1, store: 'x'.repeat(10000) }
    const errors = { progress: { name: 'Error', message: 'HTTP 503: ' + 'x'.repeat(10000) } }
    const output = api.compactStatus(payloads.freshness, meta, null, null, errors)
    assert.match(output, /^status=partial/)
    assert.match(output, /\/progress: Error: HTTP 503:/)
    assert.ok(output.length < 3100)
  })
})
