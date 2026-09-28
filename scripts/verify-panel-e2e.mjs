// 面板的端到端校验：用**本机真实配置**（真实 2 GiB+ store）跑一遍面板动作。
//
// 只读原则：state / inspect / detect / browse 都是只读的。
// save 会写文件，因此它在**临时配置目录**里验证（SEKAISYNC_CONFIG_DIR 指向副本），
// 并在结束时断言仓库里的真实 config.local.json 逐字节未变。
//
// 本脚本同时是「面板迁移到 connection.fetch.register 之后仍然工作」的回归防线。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerPanelRoutes, PANEL_BASE } from '../lib/panel.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const realConfigPath = join(root, 'config.local.json')
const realBefore = existsSync(realConfigPath) ? readFileSync(realConfigPath) : null

/**
 * 起一个最小服务器，复现框架在 /api 前缀上的桥接行为：
 * HTTP 请求 → WHATWG Request → route.fetch(request) → Response → socket。
 */
async function serve(configDir) {
  const routes = new Map()
  const previous = process.env.SEKAISYNC_CONFIG_DIR
  if (configDir) process.env.SEKAISYNC_CONFIG_DIR = configDir
  const dispose = registerPanelRoutes({
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    get: () => undefined,
  })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const route = routes.get(url.pathname)
    if (!route) { res.writeHead(404); res.end('not found'); return }
    if (!route.methods.includes(req.method ?? 'GET')) { res.writeHead(405); res.end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = new Request(url, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    })
    const response = await route.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}${PANEL_BASE}`
  return {
    base,
    close: async () => {
      dispose()
      await new Promise((r) => server.close(r))
      if (previous === undefined) delete process.env.SEKAISYNC_CONFIG_DIR
      else process.env.SEKAISYNC_CONFIG_DIR = previous
    },
  }
}

const post = async (base, action, body) => {
  const res = await fetch(`${base}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  })
  return { status: res.status, body: await res.json() }
}

const line = (label, value) => console.log(`  ${String(label).padEnd(14)} ${value}`)

// ── 1. 只读动作：对真实部署 ──
const server = await serve(undefined)
try {
  const state = await post(server.base, 'state')
  assert.equal(state.status, 200)
  assert.equal(state.body.ok, true)
  const v = state.body.value

  console.log('=== state（真实配置）===')
  line('store', v.effective.store)
  line('root', v.effective.root)
  line('layer', `${v.fields.store.source} (shadowedBy=${v.fields.store.shadowedBy})`)
  line('current', v.current ? `ok=${v.current.ok} kind=${v.current.kind}` : 'null')
  line('database', v.current ? `${v.current.databaseBytes} bytes / ${v.current.kbEntries} kb entries` : '-')
  line('writable', JSON.stringify(v.writable))
  line('candidates', v.candidates.length)

  // 这台机器上的真实部署应当被识别出来（否则面板会误导用户）
  assert.ok(v.resolvedStore, `the real deployment must resolve, got error: ${v.resolveError}`)
  assert.equal(v.current.ok, true, 'the effective store must classify as usable')
  assert.equal(v.current.hasDatabase, true, 'the real store has a database')
  assert.ok(v.current.databaseBytes > 1024 * 1024, 'the real database is non-trivial in size')
  assert.equal(v.fields.store.source, 'local-file', 'this machine configures the store in config.local.json')
  assert.equal(v.writable.store, true, 'nothing shadows the local file here')

  // inspect / detect / browse 都应工作
  const inspect = await post(server.base, 'inspect', { path: v.effective.store })
  assert.equal(inspect.body.value.ok, true)
  assert.equal(inspect.body.value.store, v.effective.store)

  const detected = await post(server.base, 'detect')
  assert.equal(detected.body.ok, true)
  assert.ok(Array.isArray(detected.body.value.candidates))

  const browse = await post(server.base, 'browse', { path: v.effective.root })
  assert.equal(browse.body.ok, true)
  assert.equal(browse.body.value.path, v.effective.root)
  assert.ok(browse.body.value.entries.length > 0, 'the repository root has subdirectories')

  console.log('\n=== detect / inspect / browse ===')
  line('inspect', `kind=${inspect.body.value.kind} ok=${inspect.body.value.ok}`)
  line('detect', `${detected.body.value.candidates.length} candidate(s)`)
  line('browse', `${browse.body.value.entries.length} dirs under the root`)
} finally { await server.close() }

// ── 2. 写动作：在临时配置目录里验证，绝不动真实文件 ──
const scratch = mkdtempSync(join(tmpdir(), 'sks-e2e-'))
try {
  // 用真实配置的副本作为起点，验证「写入保留其它键」
  if (realBefore) copyFileSync(realConfigPath, join(scratch, 'config.local.json'))
  writeFileSync(join(scratch, 'config.json'), JSON.stringify({ store: null, root: null, python: 'python', externalPort: 8787 }))

  const scratchServer = await serve(scratch)
  try {
    const state = await post(scratchServer.base, 'state')
    const realStore = state.body.value.effective.store
    const realRoot = state.body.value.effective.root

    // 保存一个真实可用的路径
    const saved = await post(scratchServer.base, 'save', { store: realStore })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.ok, true)

    const onDisk = JSON.parse(readFileSync(join(scratch, 'config.local.json'), 'utf8'))
    assert.equal(onDisk.store, realStore)
    assert.equal(onDisk.root, realRoot, 'root is derived from the store when omitted')
    // 副本里的其它键必须保留（真实配置含 python / externalPort）
    if (realBefore) {
      const original = JSON.parse(realBefore.toString('utf8'))
      for (const key of Object.keys(original)) {
        assert.ok(key in onDisk, `unrelated key "${key}" must survive the write`)
      }
    }
    console.log('\n=== save（临时配置目录）===')
    line('saved store', onDisk.store)
    line('saved root', onDisk.root)
    line('keys kept', Object.keys(onDisk).join(', '))

    // 无效路径必须被拒
    const rejected = await post(scratchServer.base, 'save', { store: join(scratch, 'nope') })
    assert.equal(rejected.status, 400)
    assert.match(rejected.body.error.message, /store 校验未通过/)
    line('invalid save', `rejected (${rejected.body.error.code})`)
  } finally { await scratchServer.close() }
} finally { rmSync(scratch, { recursive: true, force: true }) }

// ── 3. 真实配置必须逐字节未变 ──
if (realBefore !== null) {
  const realAfter = readFileSync(realConfigPath)
  assert.ok(realBefore.equals(realAfter), 'the repository config.local.json must be untouched')
}
console.log('\n=== 安全性 ===')
line('real config', realBefore === null ? '(absent, unchanged)' : 'untouched (byte-identical)')
console.log('\npanel end-to-end verification passed')
