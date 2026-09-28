// lib/panel.js 的路由测试。
// 迁移到 connection.fetch.register 之后，注册契约变了：
//   - 路由不再是 webServer.register({kind, path, handler(req,res)})，
//     而是 connection.fetch.register({ path, methods, requestBody, fetch(request) }),
//     并**返回一个 Response**（框架负责写回 socket）。
//   - 路径由框架强制落在 `/api` 前缀内。
// 因此这里用一个最小「/api 前缀 + 精确路由分发」的 node:http 服务器来复现框架行为，
// 端到端验证信封与三道安全闸。全程离线（test 动作用假 store 必然失败，正好验证失败信封）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPanelRoutes, PANEL_BASE, PANEL_RELATIVE_BASE } from '../lib/panel.js'
import { getPluginRoot } from '../lib/backend.js'

// 安全前提：这些测试绝不能写到真实的插件 config.local.json。
// 它们全部依赖 SEKAISYNC_CONFIG_DIR 把配置目录指向临时目录；这里先断言该机制可用，
// 否则一旦有人删掉那个 seam，测试会静默地改掉本机的真实配置。
test('safety: the config-directory seam works, so these tests cannot touch the real config', () => {
  const real = getPluginRoot()
  const probe = mkdtempSync(join(tmpdir(), 'sks-seam-'))
  try {
    const previous = process.env.SEKAISYNC_CONFIG_DIR
    process.env.SEKAISYNC_CONFIG_DIR = probe
    assert.equal(getPluginRoot(), probe, 'SEKAISYNC_CONFIG_DIR must redirect the config directory')
    assert.notEqual(getPluginRoot(), real)
    if (previous === undefined) delete process.env.SEKAISYNC_CONFIG_DIR
    else process.env.SEKAISYNC_CONFIG_DIR = previous
  } finally { rmSync(probe, { recursive: true, force: true }) }
})

/**
 * 复现框架行为：注册精确 Fetch 路由，并像 dsh-client-connection 的 /api 前缀那样
 * 把 HTTP 请求桥接成 WHATWG Request、把返回的 Response 写回 socket。
 * 同时模拟「鉴权失败」——框架在进入路由前就会拒掉，因此这里也照做。
 */
async function serve({ pluginRoot, unauthorized = false, picker } = {}) {
  const routes = new Map()
  const fakeCtx = {
    connection: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    get: (name) => (name === 'directoryPicker' ? picker : undefined),
  }
  const previous = process.env.SEKAISYNC_CONFIG_DIR
  if (pluginRoot) process.env.SEKAISYNC_CONFIG_DIR = pluginRoot
  const dispose = registerPanelRoutes(fakeCtx)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    // 框架在 /api 前缀上先做 Host/Origin + cookie 裁决
    if (unauthorized) { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('unauthorized'); return }
    const route = routes.get(url.pathname)
    if (route === undefined) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
    if (!route.methods.includes(req.method ?? 'GET')) { res.writeHead(405); res.end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = new Request(url, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    })
    const response = await route.fetch(request)
    const headers = Object.fromEntries(response.headers.entries())
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    url: `http://127.0.0.1:${server.address().port}${PANEL_BASE}`,
    close: async () => {
      dispose()
      await new Promise((r) => server.close(r))
      if (previous === undefined) delete process.env.SEKAISYNC_CONFIG_DIR
      else process.env.SEKAISYNC_CONFIG_DIR = previous
    },
  }
}

async function call(url, action, body) {
  const response = await fetch(`${url}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return { status: response.status, body: parsed, text }
}

/** 造一个可用 store 的部署。 */
function makeDeployment(base) {
  const root = join(base, 'deploy')
  const store = join(root, 'store')
  mkdirSync(join(store, 'kb'), { recursive: true })
  writeFileSync(join(store, 'kb', 'sekaisync.db'), Buffer.alloc(4096, 1))
  mkdirSync(join(root, 'sekaisync'), { recursive: true })
  writeFileSync(join(root, 'sekaisync', '__init__.py'), '')
  return { root, store }
}

test('panel registers one exact Fetch route per action, all under the framework /api prefix', () => {
  const routes = []
  const ctx = {
    connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } },
    get: () => undefined,
  }
  registerPanelRoutes(ctx)
  assert.equal(routes.length, 7)
  assert.deepEqual(routes.map((r) => r.path).sort(), [
    '/api/sekaisync/browse',
    '/api/sekaisync/detect',
    '/api/sekaisync/inspect',
    '/api/sekaisync/pick',
    '/api/sekaisync/save',
    '/api/sekaisync/state',
    '/api/sekaisync/test',
  ])
  // 框架硬性要求：路径必须落在 /api 内，否则 assertFetchRoute 会抛错
  assert.ok(routes.every((r) => r.path.startsWith('/api/')), 'every route lives under /api')
  assert.ok(routes.every((r) => Array.isArray(r.methods) && r.methods.length > 0), 'every route declares methods')
  assert.ok(routes.every((r) => r.requestBody === 'buffered'), 'buffered bodies are declared')
  assert.ok(routes.every((r) => typeof r.fetch === 'function'), 'every route has a fetch handler')
})

test('the browser half uses the document-relative prefix, not an absolute path', () => {
  // 应用可能挂在子路径下；绝对路径会解析到错误位置。
  assert.equal(PANEL_BASE, '/api/sekaisync')
  assert.equal(PANEL_RELATIVE_BASE, 'api/sekaisync')
  assert.equal(PANEL_RELATIVE_BASE.startsWith('/'), false, 'the client prefix is document-relative')
})

test('state reports effective values, layer, and parsed candidates', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { root, store } = makeDeployment(pluginRoot)
  writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null, root: null, python: 'python', externalPort: 8787 }))
  writeFileSync(join(pluginRoot, 'config.local.json'), JSON.stringify({ store, root }))
  const server = await serve({ pluginRoot })
  try {
    const { status, body } = await call(server.url, 'state')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.value.effective.store, store)
    assert.equal(body.value.fields.store.source, 'local-file')
    assert.equal(body.value.current.ok, true)
    assert.equal(body.value.current.hasDatabase, true)
    assert.ok(Array.isArray(body.value.candidates))
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('inspect classifies a repo root and rejects a plain directory with a reason', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { root, store } = makeDeployment(pluginRoot)
  const plain = join(pluginRoot, 'plain')
  mkdirSync(plain)
  const server = await serve({ pluginRoot })
  try {
    const good = await call(server.url, 'inspect', { path: root })
    assert.equal(good.body.ok, true)
    assert.equal(good.body.value.store, store)
    assert.equal(good.body.value.kind, 'repo-root')

    // 校验失败仍是 HTTP 200 + ok:true，但 value.ok=false（面板据此提示原因）
    const bad = await call(server.url, 'inspect', { path: plain })
    assert.equal(bad.body.ok, true)
    assert.equal(bad.body.value.ok, false)
    assert.equal(bad.body.value.reason, 'no-store-found')
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('save writes config.local.json and reloads, preserving unrelated keys', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { root, store } = makeDeployment(pluginRoot)
  writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null, root: null, python: 'python', externalPort: 8787 }))
  writeFileSync(join(pluginRoot, 'config.local.json'), JSON.stringify({ python: 'python', externalPort: 8787 }))
  const server = await serve({ pluginRoot })
  try {
    const { status, body } = await call(server.url, 'save', { store })
    assert.equal(status, 200)
    assert.equal(body.ok, true, JSON.stringify(body))
    assert.equal(body.value.store, store)

    const onDisk = JSON.parse(readFileSync(join(pluginRoot, 'config.local.json'), 'utf8'))
    assert.equal(onDisk.store, store)
    assert.equal(onDisk.root, root, 'root is derived when omitted')
    assert.equal(onDisk.python, 'python', 'unrelated keys survive')
    assert.equal(onDisk.externalPort, 8787, 'unrelated keys survive')
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('save refuses an invalid path rather than pointing the KB at a broken directory', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { root } = makeDeployment(pluginRoot)
  writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null }))
  const server = await serve({ pluginRoot })
  try {
    const missing = await call(server.url, 'save', { store: join(root, 'does-not-exist') })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.ok, false)
    assert.match(missing.body.error.message, /store 校验未通过/)
    // 未通过校验的保存绝不能落盘
    assert.equal(readFileSync(join(pluginRoot, 'config.json'), 'utf8').includes('does-not-exist'), false)
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('browse lists subdirectories with breadcrumbs and rejects an unusable path', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  mkdirSync(join(pluginRoot, 'inner', 'deep'), { recursive: true })
  writeFileSync(join(pluginRoot, 'inner', 'file.txt'), 'x')
  const server = await serve({ pluginRoot })
  try {
    const listing = await call(server.url, 'browse', { path: pluginRoot })
    assert.equal(listing.body.ok, true)
    assert.equal(listing.body.value.path, pluginRoot)
    const names = listing.body.value.entries.map((e) => e.name)
    assert.ok(names.includes('inner'))
    assert.equal(names.includes('file.txt'), false, 'only directories are listed')
    assert.ok(listing.body.value.crumbs.length >= 1)

    const bad = await call(server.url, 'browse', { path: join(pluginRoot, 'nope') })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('pick degrades gracefully when no directory picker is mounted', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const server = await serve({ pluginRoot })
  try {
    const { body } = await call(server.url, 'pick')
    assert.equal(body.ok, true)
    assert.equal(body.value.available, false)
    assert.equal(body.value.reason, 'no-picker')
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('pick opens a native chooser when present and reports cancellation', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  let behaviour = { kind: 'native', pick: async () => null }
  const server = await serve({ pluginRoot, picker: { capability: () => behaviour } })
  try {
    const cancelled = await call(server.url, 'pick')
    assert.equal(cancelled.body.value.available, true)
    assert.equal(cancelled.body.value.cancelled, true)

    behaviour = { kind: 'browse', list: async () => ({}) }
    const browseMode = await call(server.url, 'pick')
    assert.equal(browseMode.body.value.available, false, 'browse mode does not open an OS dialog')

    behaviour = { kind: 'native', pick: async () => pluginRoot }
    const chosen = await call(server.url, 'pick')
    assert.equal(chosen.body.value.cancelled, false)
    assert.equal(chosen.body.value.path, pluginRoot)
    assert.ok(chosen.body.value.inspected, 'the chosen path is classified for the panel')
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('security: an unauthenticated caller is refused before reaching any action', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { store } = makeDeployment(pluginRoot)
  writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null }))
  // 框架的 /api 栅栏在 Host/Origin + cookie 判定失败时就拒绝，路由根本不会被调用。
  const server = await serve({ pluginRoot, unauthorized: true })
  try {
    const { status, body } = await call(server.url, 'state')
    assert.equal(status, 401)
    assert.equal(body, null, 'the fence answers plain text, not our envelope')
    // 被拒绝的请求不该有任何副作用
    assert.equal(readFileSync(join(pluginRoot, 'config.json'), 'utf8'), JSON.stringify({ store: null }))
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('security: GET is refused because the route declares POST only', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const server = await serve({ pluginRoot })
  try {
    const response = await fetch(`${server.url}/state`, { method: 'GET' })
    assert.equal(response.status, 405, 'declared methods are enforced by the registry')
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('malformed, non-object and unknown-action bodies are handled without touching configuration', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null }))
  const server = await serve({ pluginRoot })
  try {
    const notJson = await fetch(`${server.url}/inspect`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
    })
    assert.equal(notJson.status, 400)
    assert.equal((await notJson.json()).error.code, 'bad-request')

    const arrayBody = await fetch(`${server.url}/inspect`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2,3]',
    })
    assert.equal(arrayBody.status, 400)

    // 空体等价于 {}（state/detect/pick 都不需要参数）
    const empty = await fetch(`${server.url}/detect`, { method: 'POST' })
    assert.equal(empty.status, 200)
    assert.equal((await empty.json()).ok, true)

    const unknown = await fetch(`${server.url}/nope`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(unknown.status, 404)

    assert.equal(readFileSync(join(pluginRoot, 'config.json'), 'utf8'), JSON.stringify({ store: null }))
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('test action returns a structured failure instead of throwing when the store is unusable', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  // 指向一个不存在的 store，让调用必然失败——但信封必须是 ok:true + value.ok:false
  writeFileSync(join(pluginRoot, 'config.local.json'), JSON.stringify({ store: join(pluginRoot, 'gone'), root: pluginRoot }))
  const server = await serve({ pluginRoot })
  try {
    const { status, body } = await call(server.url, 'test')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.value.ok, false)
    assert.equal(typeof body.value.error, 'string')
    assert.ok(body.value.error.length > 0)
  } finally { await server.close(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('dispose removes every route it registered', () => {
  const routes = new Map()
  const ctx = {
    connection: {
      fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    },
    get: () => undefined,
  }
  const dispose = registerPanelRoutes(ctx)
  assert.equal(routes.size, 7)
  dispose()
  assert.equal(routes.size, 0)
})
