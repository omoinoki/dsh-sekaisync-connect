import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const canonicalLanguages = ['ja', 'en', 'zh_hans', 'zh_hant', 'ko']
const regions = ['jp', 'en', 'tc', 'kr', 'cn']

test('registered tool contracts preserve legacy calls and distinguish execution failures', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sekaisync-tool-contract-'))
  mkdirSync(join(root, 'kb'))
  writeFileSync(join(root, 'kb', 'sekaisync.db'), 'fixture')
  const requests = []
  let serverMode = 'ok'
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/health') {
      res.end('{"status":"ok","ready":true}')
      return
    }
    requests.push(url)
    const statusPartialError = serverMode === 'status-partial' && ['/api/v1/progress', '/api/v1/data_gaps'].includes(url.pathname)
    const statusCoreError = serverMode === 'status-core' && url.pathname === '/api/v1/freshness'
    if (serverMode === 'http-error' || statusPartialError || statusCoreError) {
      res.writeHead(503)
      res.end('{"error":"fixture-unavailable"}')
      return
    }
    if (serverMode === 'invalid-json') { res.end('{invalid'); return }
    const entityId = url.searchParams.get('entity_id')
    if (entityId?.includes('slow')) await delay(100)
    if (url.searchParams.get('query') === 'enrichment-cancel' && url.pathname !== '/api/v1/lookup') await delay(100)
    if (url.pathname === '/api/v1/fact_pack') {
      if (entityId === 'character_profile:not-found') { res.end('null'); return }
      const state = entityId?.split(':')[1]
      const domainStatus = ['conflict', 'needs_region'].includes(state) ? 'needs_region' : state === 'missing' ? 'missing' : 'available'
      const pack = {
        entity_id: entityId,
        text: `Profile ${entityId}${domainStatus === 'available' ? '\nBody fixture' : ''}`,
        trust: 'official', fact_pack_tokens: 10, raw_json_tokens: 50, token_ratio: 0.2,
        effective_language: url.searchParams.get('language'),
        region: url.searchParams.get('region'),
        region_scope: domainStatus === 'missing' ? 'entity' : url.searchParams.has('region') ? 'region' : 'common',
        available_regions: ['jp', 'en'],
        content_status: domainStatus,
        coverage: domainStatus,
        needs_region: domainStatus === 'needs_region',
      }
      if (serverMode === 'legacy-fact') { delete pack.region; delete pack.region_scope }
      if (serverMode === 'wrong-region') pack.region = 'en'
      if (serverMode === 'wrong-scope') pack.region_scope = 'entity'
      res.end(JSON.stringify(pack))
      return
    }
    if (url.pathname === '/api/v1/lookup') {
      res.end(JSON.stringify({ results: [{ id: 'event:1', type: 'event', names: { en: 'Fixture' }, facts: { title: 'fixture' }, trust: 'official' }] }))
      return
    }
    res.end(JSON.stringify({ results: [], query: url.searchParams.get('query'), trust: 'official' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const keys = ['SEKAISYNC_STORE', 'SEKAISYNC_ROOT', 'SEKAISYNC_PORT', 'SEKAISYNC_PYTHON']
  const oldEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    SEKAISYNC_STORE: root, SEKAISYNC_ROOT: root,
    SEKAISYNC_PORT: String(server.address().port), SEKAISYNC_PYTHON: process.execPath,
  })
  const backend = await import('../lib/backend.js')
  const { apply, BUDGETS } = await import('../lib/index.js')
  const tools = new Map()
  apply({
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } },
    effect: (fn) => fn(), inject: () => () => {}, on: () => () => {},
  })
  t.after(async () => {
    backend.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  const fact = tools.get('sekai_fact')
  const requiredTools = ['sekai_probe', 'sekai_lookup', 'sekai_fact', 'sekai_resolve', 'sekai_term', 'sekai_penetrate', 'sekai_alias', 'sekai_web']
  const httpTools = [
    ['sekai_lookup', { query: 'fixture' }],
    ['sekai_fact', { entity_id: 'character_profile:fixture' }],
    ['sekai_resolve', { query: 'fixture' }],
    ['sekai_term', { query: 'fixture' }],
    ['sekai_penetrate', { query: 'fixture' }],
    ['sekai_web', { query: 'fixture' }],
    ['sekai_news', {}],
  ]

  await t.test('ten tools retain string output declarations', () => {
    assert.equal(tools.size, 10)
    for (const tool of tools.values()) {
      assert.deepEqual(tool.output.schema, { type: 'string' })
      assert.deepEqual(tool.output.render({}, 'fixture'), [{ type: 'text', text: 'fixture' }])
      assert.equal(tool.parameters.type, 'object')
    }
  })

  await t.test('fact schema exposes only optional region and narrowly adds Chinese aliases', () => {
    assert.deepEqual(fact.parameters.required, ['entity_id'])
    assert.deepEqual(fact.parameters.properties.region.enum, regions)
    assert.deepEqual(fact.parameters.properties.language.enum, [...canonicalLanguages, 'zh_cn', 'zh_tw'])
    assert.equal(fact.parameters.properties.language.default, 'en')
    assert.equal(fact.parameters.properties.as_of, undefined)
    assert.deepEqual(tools.get('sekai_lookup').parameters.properties.language.enum, canonicalLanguages)
    assert.deepEqual(tools.get('sekai_resolve').parameters.properties.target_language.enum, canonicalLanguages)
  })

  await t.test('missing required parameters reject before HTTP instead of returning ERROR strings', async () => {
    const before = requests.length
    for (const name of requiredTools) await assert.rejects(tools.get(name).execute({}), TypeError)
    assert.equal(requests.length, before)
  })

  await t.test('non-object and malformed values reject before HTTP', async () => {
    const before = requests.length
    for (const value of [[], 'invalid', 4, true]) await assert.rejects(fact.execute(value), TypeError)
    for (const args of [
      { entity_id: {} }, { entity_id: 'profile:1', region: 'invalid' },
      { entity_id: 'profile:1', language: 'zh-tw' }, { entity_id: 'profile:1', region: 1 },
    ]) await assert.rejects(fact.execute(args), TypeError)
    await assert.rejects(tools.get('sekai_lookup').execute({ query: 'fixture', limit: Infinity }), TypeError)
    await assert.rejects(tools.get('sekai_resolve').execute({ query: 'fixture', target_language: 'zh_tw' }), TypeError)
    assert.equal(requests.length, before)
  })

  await t.test('legacy unscoped fact calls preserve the English default and omit region', async () => {
    assert.equal(typeof await fact.execute({ entity_id: 'character_profile:legacy' }), 'string')
    const url = requests.at(-1)
    assert.equal(url.pathname, '/api/v1/fact_pack')
    assert.equal(url.searchParams.get('entity_id'), 'character_profile:legacy')
    assert.equal(url.searchParams.get('language'), 'en')
    assert.equal(url.searchParams.has('region'), false)
  })

  await t.test('canonical and supported alias languages are forwarded without silent rewriting', async () => {
    for (const language of [...canonicalLanguages, 'zh_cn', 'zh_tw']) {
      assert.equal(typeof await fact.execute({ entity_id: `character_profile:lang-${language}`, language }), 'string')
      assert.equal(requests.at(-1).searchParams.get('language'), language)
    }
  })

  await t.test('each optional region reaches the fact_pack HTTP endpoint', async () => {
    for (const region of regions) {
      assert.equal(typeof await fact.execute({ entity_id: `character_profile:region-${region}`, region, language: 'ja' }), 'string')
      assert.equal(requests.at(-1).searchParams.get('region'), region)
      assert.equal(requests.at(-1).searchParams.get('language'), 'ja')
    }
  })

  await t.test('old backend payloads remain compatible for unscoped calls but reject unconfirmed region', async () => {
    serverMode = 'legacy-fact'
    backend.dispose()
    try {
      assert.equal(typeof await fact.execute({ entity_id: 'character_profile:old-unscoped' }), 'string')
      await assert.rejects(fact.execute({ entity_id: 'character_profile:old-scoped', region: 'jp' }), /region=jp/)
    } finally { serverMode = 'ok'; backend.dispose() }
  })

  await t.test('a backend selecting a different region cannot claim scoped success', async () => {
    serverMode = 'wrong-region'
    backend.dispose()
    try { await assert.rejects(fact.execute({ entity_id: 'character_profile:wrong-region', region: 'jp' }), /region=jp/) }
    finally { serverMode = 'ok'; backend.dispose() }
  })

  await t.test('matching region without regional scope cannot claim scoped success', async () => {
    serverMode = 'wrong-scope'
    backend.dispose()
    try { await assert.rejects(fact.execute({ entity_id: 'character_profile:wrong-scope', region: 'jp' }), /region=jp/) }
    finally { serverMode = 'ok'; backend.dispose() }
  })

  await t.test('explicit region with missing coverage or a missing entity remains an honest domain result', async () => {
    for (const entity_id of ['character_profile:missing', 'character_profile:not-found']) {
      const result = await fact.execute({ entity_id, region: 'jp' })
      assert.equal(typeof result, 'string')
      assert.ok(!result.startsWith('ERROR:'))
    }
  })

  await t.test('not-found and missing/conflicting bodies remain successful domain results', async () => {
    for (const state of ['not-found', 'missing', 'conflict', 'needs_region']) {
      const result = await fact.execute({ entity_id: `character_profile:${state}` })
      assert.equal(typeof result, 'string')
      assert.ok(result.length > 0)
      assert.ok(!result.startsWith('ERROR:'))
    }
  })

  await t.test('optional activity enrichment failures preserve completed lookup facts', async () => {
    const result = await tools.get('sekai_lookup').execute({ query: 'completed-event' })
    assert.match(result, /event:1/)
    assert.ok(!result.startsWith('ERROR:'))
  })

  await t.test('HTTP infrastructure failures reject all direct HTTP tool calls', async () => {
    serverMode = 'http-error'
    backend.dispose()
    try {
      for (const [name, args] of httpTools) await assert.rejects(tools.get(name).execute(args), /HTTP 503/)
    } finally { serverMode = 'ok'; backend.dispose() }
  })

  await t.test('activity index failure permits healthy HTTP fallback domain results', async () => {
    // Node used as the fake Python exits on -u; the healthy HTTP route remains usable.
    assert.equal(typeof await tools.get('sekai_alias').execute({ query: 'khn3' }), 'string')
  })

  await t.test('activity rejects when both index and HTTP fallback are unavailable', async () => {
    serverMode = 'http-error'
    backend.dispose()
    try { await assert.rejects(tools.get('sekai_alias').execute({ query: 'khn3' }), /503|unavailable|\u4e0d\u53ef\u7528/) }
    finally { serverMode = 'ok'; backend.dispose() }
  })

  await t.test('status rejects a failed mandatory freshness endpoint', async () => {
    serverMode = 'status-core'
    backend.dispose()
    try { await assert.rejects(tools.get('sekai_status').execute({}), /freshness/) }
    finally { serverMode = 'ok'; backend.dispose() }
  })

  await t.test('partial status retains mandatory data but warns about both missing optional endpoints', async () => {
    serverMode = 'status-partial'
    backend.dispose()
    try {
      const result = await tools.get('sekai_status').execute({})
      assert.equal(typeof result, 'string')
      assert.match(result, /progress/)
      assert.match(result, /data_gaps/)
      assert.match(result, /503/)
    } finally { serverMode = 'ok'; backend.dispose() }
  })

  await t.test('invalid HTTP JSON rejects instead of returning successful prose', async () => {
    serverMode = 'invalid-json'
    backend.dispose()
    try { await assert.rejects(fact.execute({ entity_id: 'character_profile:invalid-json' }), SyntaxError) }
    finally { serverMode = 'ok'; backend.dispose() }
  })

  await t.test('already cancelled executions reject without dispatch for all tools', async () => {
    const abort = new AbortController()
    abort.abort()
    const before = requests.length
    for (const tool of tools.values()) {
      const args = tool.name === 'sekai_fact' ? { entity_id: 'profile:1' } : { query: 'fixture' }
      await assert.rejects(tool.execute(args, { signal: abort.signal }), { name: 'AbortError' })
    }
    assert.equal(requests.length, before)
  })

  await t.test('in-flight cancellation reaches backend fetch and rejects', async () => {
    const abort = new AbortController()
    const pending = fact.execute({ entity_id: 'character_profile:slow-cancel' }, { signal: abort.signal })
    await delay(15)
    abort.abort()
    await assert.rejects(pending, /\u5df2\u53d6\u6d88/)
  })

  await t.test('cancellation during optional enrichment cannot become a successful lookup', async () => {
    const abort = new AbortController()
    const before = requests.length
    const pending = tools.get('sekai_lookup').execute({ query: 'enrichment-cancel' }, { signal: abort.signal })
    for (let i = 0; i < 50; i++) {
      if (requests.slice(before).some((url) => url.pathname === '/api/v1/activity')) break
      await delay(10)
    }
    assert.ok(requests.slice(before).some((url) => url.pathname === '/api/v1/activity'))
    abort.abort()
    await assert.rejects(pending, /\u5df2\u53d6\u6d88/)
  })

  await t.test('inner deadline failures reject and do not poison later calls', async () => {
    const budget = BUDGETS.fact.inner
    BUDGETS.fact.inner = 15
    try { await assert.rejects(fact.execute({ entity_id: 'character_profile:slow-timeout' }), /\u8d85\u65f6/) }
    finally { BUDGETS.fact.inner = budget }
    assert.equal(typeof await fact.execute({ entity_id: 'character_profile:after-timeout' }), 'string')
  })
})
