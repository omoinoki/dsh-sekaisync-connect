import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ByteLru, RequestPool, readBoundedText, runCommand, compactExcerpt } from '../lib/runtime.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('byte LRU enforces entry/byte limits, expiry and recency', async () => {
  const cache = new ByteLru({ maxEntries: 2, maxBytes: 100, maxEntryBytes: 60 })
  cache.set('a', 1, 1000, 20)
  cache.set('b', 2, 1000, 20)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3, 1000, 20)
  assert.equal(cache.get('b'), undefined)
  assert.ok(cache.bytes <= 100)
  cache.set('large', 4, 1000, 1000)
  assert.equal(cache.get('large'), undefined)
  cache.set('exp', 5, 1, 1)
  await delay(5)
  assert.equal(cache.get('exp'), undefined)
  cache.clear()
  assert.equal(cache.bytes, 0)
})

test('response budgets include streamed bodies and cancel oversized/error data', async () => {
  await assert.rejects(readBoundedText(new Response('123456'), 5), /字节预算/)
  await assert.rejects(readBoundedText(new Response('1', { headers: { 'content-length': '100' } }), 5), /字节预算/)
  assert.deepEqual(await readBoundedText(new Response('123456'), 5, { truncate: true }), { text: '12345', bytes: 5 })
  assert.deepEqual(await readBoundedText(new Response('中文'), 6), { text: '中文', bytes: 6 })
})

test('single-flight cancellation is independent and last cancellation aborts upstream', async () => {
  const pool = new RequestPool(1)
  const first = new AbortController()
  const second = new AbortController()
  let calls = 0
  let upstream
  const start = async (signal) => { calls++; upstream = signal; await delay(40); return 'ok' }
  const one = pool.run('same', start, first.signal)
  const two = pool.run('same', start, second.signal)
  first.abort(new Error('first cancelled'))
  await assert.rejects(one, /first cancelled/)
  assert.equal(upstream.aborted, false)
  assert.equal(await two, 'ok')
  assert.equal(calls, 1)
  const last = new AbortController()
  const pending = pool.run('last', start, last.signal)
  await delay(1)
  await assert.rejects(pool.run('overflow', start), /队列已满/)
  last.abort(new Error('last cancelled'))
  await assert.rejects(pending, /last cancelled/)
  assert.equal(upstream.aborted, true)
  await delay(45)
})

test('CLI work yields the event loop and retains shell-free argument boundaries', async () => {
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  try {
    const arg = '$(echo unsafe) & a b'
    const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => console.log(process.argv[1]), 80)', arg], { timeout: 2000, maxBuffer: 4096 })
    assert.equal(result.stdout.trim(), arg)
    assert.ok(ticks > 5, `event loop ticks=${ticks}`)
    await assert.rejects(runCommand(process.execPath, ['-e', 'console.log("x".repeat(10000))'], { maxBuffer: 10 }))
  } finally { clearInterval(timer) }
})

test('bounded excerpts preserve whitespace normalization and truncation for long prose', () => {
  for (const value of ['  abc  def \n ghi  ', '\n\t', 'a'.repeat(200000), '中 文\u3000段落\n', 'x'.repeat(1200) + '  ']) {
    for (const limit of [1, 4, 1200]) {
      const normalized = value.replace(/\s+/g, ' ').trim()
      assert.deepEqual(compactExcerpt(value, limit), { text: normalized.slice(0, limit), truncated: normalized.length > limit })
    }
  }
})

test('HTTP contract, generation invalidation, deadlines and tool validation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sekaisync-connect-test-'))
  mkdirSync(join(root, 'kb'))
  const database = join(root, 'kb', 'sekaisync.db')
  writeFileSync(database, 'fixture')
  const counts = new Map()
  const urls = []
  let healthCalls = 0
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/health') {
      healthCalls++
      await delay(60)
      res.setHeader('Content-Type', 'application/json')
      res.end('{"status":"ok","ready":true}')
      return
    }
    urls.push(url)
    const query = url.searchParams.get('query') || ''
    counts.set(query, (counts.get(query) || 0) + 1)
    if (query.startsWith('slow')) await delay(90)
    if (query === 'enrichment') {
      if (url.pathname !== '/api/v1/lookup') await delay(90)
      res.end(JSON.stringify({ query, results: [{ id: 'event:1', type: 'event', trust: 'official' }] }))
      return
    }
    if (query === 'redirect') { res.writeHead(302, { Location: '/must-not-follow' }); res.end(); return }
    if (query === 'large') { res.writeHead(200, { 'Content-Length': String(129 * 1024 * 1024) }); res.write('x'); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ query, results: [], trust: 'official', visit: counts.get(query) }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const oldEnv = Object.fromEntries(['SEKAISYNC_STORE', 'SEKAISYNC_ROOT', 'SEKAISYNC_PORT', 'SEKAISYNC_PYTHON'].map((key) => [key, process.env[key]]))
  Object.assign(process.env, { SEKAISYNC_STORE: root, SEKAISYNC_ROOT: root, SEKAISYNC_PORT: String(server.address().port), SEKAISYNC_PYTHON: process.execPath })
  const api = await import('../lib/backend.js')
  t.after(async () => {
    api.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(root, { recursive: true, force: true })
  })

  const began = performance.now()
  await assert.rejects(api.call('lookup', { query: 'cold' }, { timeoutMs: 15 }), /超时/)
  assert.ok(performance.now() - began < 150, 'startup must share the caller deadline')
  await delay(80)
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => api.call('web_lookup', i % 2 ? { query: 'parallel', limit: 5 } : { limit: 5, query: 'parallel' })))
  assert.ok(answers.every((value) => value.trust === 'official'))
  assert.equal(counts.get('parallel'), 1)
  await api.call('web_lookup', { query: 'parallel', limit: 5 })
  assert.equal(counts.get('parallel'), 1)
  assert.equal(healthCalls, 1)
  appendFileSync(database, 'revision2')
  await api.call('web_lookup', { query: 'parallel', limit: 5 })
  assert.equal(counts.get('parallel'), 2)

  const cancelling = new AbortController()
  const one = api.call('lookup', { query: 'slow-cancel' }, { signal: cancelling.signal })
  const two = api.call('lookup', { query: 'slow-cancel' })
  await delay(10)
  cancelling.abort()
  await assert.rejects(one, /已取消/)
  assert.equal((await two).query, 'slow-cancel')
  assert.equal(counts.get('slow-cancel'), 1)
  await assert.rejects(api.call('lookup', { query: 'slow-cancel' }, { signal: cancelling.signal }), /已取消/)

  const crossing = api.call('lookup', { query: 'slow-generation' })
  await delay(15)
  appendFileSync(database, 'revision3')
  await crossing
  await api.call('lookup', { query: 'slow-generation' })
  assert.equal(counts.get('slow-generation'), 2, 'old snapshot must not poison the new generation cache')
  await assert.rejects(api.call('lookup', { query: 'slow-timeout' }, { timeoutMs: 10 }), /超时/)
  await assert.rejects(api.call('../write', {}), /非法 API/)
  await assert.rejects(api.call('lookup', { query: {} }), /必须是/)
  await assert.rejects(api.call('lookup', { query: 'redirect' }))
  assert.ok(!urls.some((url) => url.pathname === '/must-not-follow'))
  await assert.rejects(api.call('lookup', { query: 'large' }), /字节预算/)
  await api.call('news', { body: false, limit: 200 })
  assert.equal(urls.at(-1).searchParams.get('body'), 'false')
  assert.equal(urls.at(-1).searchParams.get('limit'), '100')

  const tools = []
  const { apply, BUDGETS } = await import('../lib/index.js')
  // ctx.on 是必需的：apply 会在 loader/volatile-update 上挂监听器，用来在
  // 「volatile-only 改动不重启插件行」时丢弃派生的缓存。
  apply({
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    effect: (fn) => fn(),
    inject: () => () => {},
    on: () => () => {},
  })
  assert.equal(tools.length, 10)
  const lookup = tools.find((tool) => tool.name === 'sekai_lookup')
  assert.match(await lookup.execute({ query: {} }), /类型/)
  assert.match(await lookup.execute({ query: 'x', limit: Infinity }), /类型/)
  assert.match(await lookup.execute({}, {}), /缺少必填/)
  const lookupBudget = BUDGETS.lookup.inner
  BUDGETS.lookup.inner = 35
  try { assert.match(await lookup.execute({ query: 'enrichment' }), /event:1/) }
  finally { BUDGETS.lookup.inner = lookupBudget }
  const alias = tools.find((tool) => tool.name === 'sekai_alias')
  assert.match(await alias.execute({ query: 'wl3' }, { signal: cancelling.signal }), /已取消/)
  const probe = tools.find((tool) => tool.name === 'sekai_probe')
  const rendered = await probe.execute({ query: '星乃一歌'.repeat(100000) })
  assert.ok(rendered.length < 3000)
  // Historically port 0 bypassed external reuse and started a managed server.
  // The fake Python (Node) exits on -u, proving validation reaches that path.
  process.env.SEKAISYNC_PORT = '0'
  api.dispose()
  await assert.rejects(api.call('lookup', { query: 'managed-zero-port' }, { timeoutMs: 1000 }), /服务器提前退出|无法启动 python/)
})
