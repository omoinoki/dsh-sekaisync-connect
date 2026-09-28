// Host 半侧集成校验：用贴近真实的 Cordis 上下文跑一遍 apply()，
// 确认 10 个工具与 7 条面板路由都被注册，且清理函数成对存在。
// 不联网、不起子进程——只校验装配与生命周期。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 用临时配置目录，绝不动真实 config.local.json
const configDir = mkdtempSync(join(tmpdir(), 'sks-host-'))
process.env.SEKAISYNC_CONFIG_DIR = configDir
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ store: null, root: null, python: 'python', externalPort: 8787 }))

const { apply, BUDGETS } = await import('../lib/index.js')

const tools = []
const effects = []
const routes = []
const childInjections = []

// 面板走 connection.fetch.register：注册的是精确 Fetch 路由，返回 Response。
const connectionCtx = {
  effect: (factory, label) => { const dispose = factory(); effects.push({ label, dispose }); return dispose },
  connection: {
    fetch: {
      register: (route) => {
        if (routes.some((r) => r.path === route.path)) throw new Error(`duplicate Fetch route ${route.path}`)
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
  },
  get: () => undefined,
}

const ctx = {
  effect: (factory, label) => { const dispose = factory(); effects.push({ label, dispose }); return dispose },
  tools: { register: (tool) => { tools.push(tool); return () => { tools.splice(tools.indexOf(tool), 1) } } },
  // 真实的 Cordis ctx.inject(deps, callback)：依赖可用时才调用 callback
  inject: (deps, callback) => {
    childInjections.push(deps)
    if (deps.includes('connection')) return callback(connectionCtx)
    return () => {}
  },
  get: () => undefined,
}

apply(ctx, null)

// ── 工具 ──
assert.equal(tools.length, 10, `expected 10 tools, got ${tools.length}`)
const toolNames = tools.map((t) => t.name).sort()
assert.deepEqual(toolNames, [
  'sekai_alias', 'sekai_fact', 'sekai_lookup', 'sekai_news', 'sekai_penetrate',
  'sekai_probe', 'sekai_resolve', 'sekai_status', 'sekai_term', 'sekai_web',
], 'the ten tools are registered under their documented names')

for (const tool of tools) {
  assert.equal(typeof tool.execute, 'function', `${tool.name}: execute is a function`)
  assert.equal(tool.parameters.type, 'object', `${tool.name}: parameters is an object schema`)
  assert.equal(typeof tool.description, 'string', `${tool.name}: has a description`)
  // DSH 的 isConcurrencySafe 是 (args) => boolean 的判定函数，不是静态布尔值。
  assert.equal(typeof tool.isConcurrencySafe, 'function', `${tool.name}: isConcurrencySafe is a predicate`)
  const verdict = tool.isConcurrencySafe({})
  assert.equal(typeof verdict, 'boolean', `${tool.name}: predicate returns a boolean`)
  assert.equal(typeof tool.timeoutMs, 'number', `${tool.name}: declares timeoutMs`)
  assert.ok(tool.timeoutMs > 0, `${tool.name}: timeoutMs is positive`)
  assert.ok(tool.output && tool.output.schema && tool.output.schema.type === 'string',
    `${tool.name}: output schema is a string`)
}

// 预算契约：外层严格大于内层（留给插件自己的错误信息先返回）
for (const [name, budget] of Object.entries(BUDGETS)) {
  assert.ok(budget.outer > budget.inner, `${name}: outer budget must exceed inner`)
}

// ── 面板路由 ──
assert.ok(childInjections.some((deps) => deps.includes('connection')),
  'apply must wait for connection before registering panel routes')
assert.equal(routes.length, 7, `expected 7 panel routes, got ${routes.length}`)
assert.deepEqual(routes.map((r) => r.path).sort(), [
  '/api/sekaisync/browse', '/api/sekaisync/detect', '/api/sekaisync/inspect',
  '/api/sekaisync/pick', '/api/sekaisync/save', '/api/sekaisync/state', '/api/sekaisync/test',
], 'panel routes are registered under the framework /api prefix')
// 框架的 assertFetchRoute 硬性要求：路径在 /api 内、methods 非空且不重复。
assert.ok(routes.every((r) => r.path.startsWith('/api/')), 'every route lives under /api (required by the framework)')
assert.ok(routes.every((r) => Array.isArray(r.methods) && r.methods.length > 0), 'methods declared')
assert.ok(routes.every((r) => new Set(r.methods).size === r.methods.length), 'no repeated methods')
assert.ok(routes.every((r) => r.requestBody === 'buffered' || r.requestBody === 'streaming'), 'requestBody is a valid mode')
assert.ok(routes.every((r) => typeof r.fetch === 'function'), 'every route has a fetch handler')

// ── 生命周期：effects 应能在不抛错的前提下全部释放 ──
assert.ok(effects.length >= 11, `expected effect cleanup for 10 tools + lifecycle, got ${effects.length}`)
const beforeDispose = { tools: tools.length, routes: routes.length }
for (const { label, dispose } of effects) {
  if (typeof dispose === 'function') {
    try { dispose() } catch (e) {
      // 释放不该抛错；子进程不存在时 dispose() 也应安全
      assert.fail(`dispose of "${label}" threw: ${e.message}`)
    }
  }
}
// 释放后注册表应被清空（这正是上面报告 0 的原因）
assert.equal(tools.length, 0, 'disposing the tool effects unregisters every tool')
assert.equal(routes.length, 0, 'disposing the panel effect removes every route')

// 真实配置未被触碰
const realLocal = join(root, 'config.local.json')
const realValue = JSON.parse(readFileSync(realLocal, 'utf8'))
assert.equal(realValue.store, 'C:\\dsh_projects\\sekaisync-handoff-2026-08-14\\store',
  'the repository config.local.json must be untouched by this verification')

rmSync(configDir, { recursive: true, force: true })
delete process.env.SEKAISYNC_CONFIG_DIR

console.log('host-half integration passed')
console.log('  tools   :', beforeDispose.tools, '(' + toolNames.join(', ') + ')')
console.log('  routes  :', beforeDispose.routes, '(all under /api/sekaisync)')
console.log('  effects :', effects.length)
console.log('  inject  :', JSON.stringify(childInjections))
console.log('  disposed:', `tools=${tools.length} routes=${routes.length} (all released cleanly)`)
