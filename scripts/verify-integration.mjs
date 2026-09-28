// node scripts/verify-integration.mjs <backend-root> [scratch-parent]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const here = dirname(fileURLToPath(import.meta.url))
const backend = resolve(process.argv[2] || join(here, '..', '..', 'sekaisync-handoff-2026-08-14'))
const parent = resolve(process.argv[3] || tmpdir())
const scratch = mkdtempSync(join(parent, 'sekaisync-connect-integration-'))
const store = join(scratch, 'store')
const python = process.env.SEKAISYNC_PYTHON || 'python'
const proc = spawn(python, ['-u', '-B', join(here, 'integration-fixture.py'), backend, store],
  { cwd: backend, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
let api
const exited = new Promise((resolveExit) => proc.once('exit', resolveExit))
try {
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${log.slice(-1200)}`)), 30000)
    proc.on('error', (error) => { clearTimeout(timer); reject(error) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`backend exit ${code}: ${log.slice(-1200)}`)) })
    proc.stderr.on('data', (chunk) => { log = (log + chunk).slice(-16000) })
    proc.stdout.on('data', (chunk) => {
      log = (log + chunk).slice(-16000)
      const match = log.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
    })
  })
  const base = `http://127.0.0.1:${port}`
  const health = await (await fetch(`${base}/health`)).json()
  assert.deepEqual(health, { status: 'ok', ready: true })
  Object.assign(process.env, { SEKAISYNC_STORE: store, SEKAISYNC_ROOT: backend, SEKAISYNC_PORT: String(port) })
  api = await import('../lib/backend.js')
  const params = { query: 'integrationneedle', language: 'ja', limit: 5, include_text: true, max_text_chars: 1200 }
  const began = performance.now()
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => api.call('web_lookup', params)))
  const coldMs = performance.now() - began
  assert.equal(concurrent[0].results.length, 5)
  assert.ok(concurrent.every((result) => JSON.stringify(result) === JSON.stringify(concurrent[0])))
  assert.ok(concurrent[0].results.every((row) => [...row.text].length === 1201 && row.text.endsWith('…')))
  const direct = await (await fetch(`${base}/api/v1/web_lookup?${new URLSearchParams(params)}`)).json()
  assert.deepEqual(concurrent[0], direct)
  assert.ok(concurrent[0].results.every((row) => typeof row.trust === 'string' && row.trust.length > 0))
  const full = await api.call('web_lookup', { ...params, limit: 1, max_text_chars: 0 })
  assert.equal([...full.results[0].text].length, 200000)
  const cachedSamples = []
  for (let i = 0; i < 4; i++) {
    const warmed = performance.now()
    await api.call('web_lookup', params)
    cachedSamples.push(+(performance.now() - warmed).toFixed(3))
  }
  const compact = api.compactWeb(concurrent[0])
  assert.match(compact, /integrationneedle/)
  assert.ok(compact.length <= 8100)
  const lookup = await api.call('lookup', { query: 'Ichika', limit: 1 })
  assert.equal(lookup.results[0].id, 'character:1')
  // Exercise an installed-package discovery path without touching the real
  // backend's production store: only the discovery import uses this stub.
  mkdirSync(join(scratch, 'cwd'))
  mkdirSync(join(scratch, 'sekaisync'))
  writeFileSync(join(scratch, 'sekaisync', '__init__.py'),
    'import time\nfrom pathlib import Path\ntime.sleep(0.08)\nwith (Path(__file__).parent.parent / "imports.txt").open("a") as f: f.write("1")\n')
  const configPath = join(scratch, 'config.json')
  writeFileSync(configPath, JSON.stringify({ store: null }))
  delete process.env.SEKAISYNC_STORE
  Object.assign(process.env, { SEKAISYNC_CONFIG: configPath, SEKAISYNC_ROOT: join(scratch, 'cwd'), PYTHONPATH: scratch })
  api.dispose()
  let discoveryTicks = 0
  const timer = setInterval(() => discoveryTicks++, 5)
  try {
    await api.call('lookup', { query: 'Ichika', limit: 1 })
    await api.call('lookup', { query: 'Ichika', limit: 1 })
    await api.call('lookup', { query: '星乃一歌', limit: 1 })
  } finally { clearInterval(timer) }
  assert.equal(readFileSync(join(scratch, 'imports.txt'), 'utf8'), '1')
  assert.ok(discoveryTicks >= 5)
  console.log(JSON.stringify({ backend, synthetic_pages: 80, text_chars_per_page: 200000,
    health, concurrent_callers: 12, matched_rows: 5, text_chars_with_ellipsis: 1201,
    unlimited_text_chars: 200000, cold_concurrent_ms: +coldMs.toFixed(3),
    repeated_ms: cachedSamples, same_rest_response: true, trust_preserved: true,
    backend_trust: concurrent[0].results[0].trust,
    python_discovery_imports_for_three_calls: 1, event_loop_ticks_during_discovery: discoveryTicks,
  }, null, 2))
} finally {
  api?.dispose()
  proc.kill()
  await exited
  // The generated child is checked before recursively removing the fixture.
  if (dirname(scratch) !== parent || !scratch.startsWith(join(parent, 'sekaisync-connect-integration-'))) throw new Error('unsafe scratch path')
  rmSync(scratch, { recursive: true, force: true })
}
