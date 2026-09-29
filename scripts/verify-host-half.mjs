// Host 半侧集成校验：用贴近真实的 Cordis 上下文跑一遍 apply()，
// 确认 10 个工具与 1 个 DeployService（Typert Remote 后端）都被注册，且清理函数成对存在。
// 不联网、不起子进程——只校验装配与生命周期。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 用临时配置目录，绝不动真实 config.local.json
const configDir = mkdtempSync(join(tmpdir(), 'sks-host-'))
process.env.SEKAISYNC_CONFIG_DIR = configDir
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ store: null, root: null, python: 'python', externalPort: 8787 }))

const { apply, BUDGETS, Config } = await import('../lib/index.js')

const tools = []
const effects = []
const childInjections = []
const childPlugins = []

// 面板走后端：一个 Typert Remote 服务（DeployService），由 ctx.inject(['settings'], cb) 里的
// settingsCtx.plugin(DeployService) 装载。这里模拟 settings 服务，并记录子插件。
const settingsCtx = {
  effect: (factory, label) => { const dispose = factory(); effects.push({ label, dispose }); return dispose },
  plugin: (plugin) => { childPlugins.push(plugin); return () => {} },
  get: (name) => (name === 'settings' ? { update: async () => {} } : undefined),
}

const ctx = {
  effect: (factory, label) => { const dispose = factory(); effects.push({ label, dispose }); return dispose },
  tools: { register: (tool) => { tools.push(tool); return () => { tools.splice(tools.indexOf(tool), 1) } } },
  // 真实的 Cordis ctx.inject(deps, callback)：依赖可用时才调用 callback
  inject: (deps, callback) => {
    childInjections.push(deps)
    if (deps.includes('settings')) return callback(settingsCtx)
    return () => {}
  },
  get: () => undefined,
}

apply(ctx, {})

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

// ── 面板后端（DeployService + Typert Remote）──
assert.ok(childInjections.some((deps) => deps.includes('settings')),
  'apply must wait for settings before mounting the panel service')
assert.equal(childPlugins.length, 1, 'exactly one panel service is mounted')
const DeployService = childPlugins[0]
assert.equal(typeof DeployService, 'function', 'the panel backend is a class/function')

// 方法必须带 Remote 标记（registerRemoteMethods 手动打的标，等价于 @Remote）。
const instance = Object.create(DeployService.prototype)
const methods = remoteMethods(instance).map((m) => m.method)
assert.deepEqual(methods.sort(), ['browse', 'detect', 'inspect', 'pick', 'save', 'state', 'test'],
  'DeployService exports the seven panel actions as Remote methods')

// Config 必须声明 store/root 为 volatile（settings 表单投影只认 .volatile()），python 不 volatile
assert.equal(Config.dict.store.meta.volatile, true, 'store must be volatile')
assert.equal(Config.dict.root.meta.volatile, true, 'root must be volatile')
assert.notEqual(Config.dict.python.meta.volatile, true, 'python must NOT be volatile (RCE guard)')

// ── 生命周期：effects 应能在不抛错的前提下全部释放 ──
assert.ok(effects.length >= 11, `expected effect cleanup for 10 tools + lifecycle, got ${effects.length}`)
const beforeDispose = { tools: tools.length }
for (const { label, dispose } of effects) {
  if (typeof dispose === 'function') {
    try { dispose() } catch (e) {
      // 释放不该抛错；子进程不存在时 dispose() 也应安全
      assert.fail(`dispose of "${label}" threw: ${e.message}`)
    }
  }
}
// 释放后工具注册表应被清空
assert.equal(tools.length, 0, 'disposing the tool effects unregisters every tool')

// 真实配置未被触碰
const realLocal = join(root, 'config.local.json')
const realValue = JSON.parse(readFileSync(realLocal, 'utf8'))
assert.equal(realValue.store, 'C:\\dsh_projects\\sekaisync-handoff-2026-08-14\\store',
  'the repository config.local.json must be untouched by this verification')

rmSync(configDir, { recursive: true, force: true })
delete process.env.SEKAISYNC_CONFIG_DIR

console.log('host-half integration passed')
console.log('  tools   :', beforeDispose.tools, '(' + toolNames.join(', ') + ')')
console.log('  panel   : DeployService with Remote methods', methods.join(', '))
console.log('  effects :', effects.length)
console.log('  inject  :', JSON.stringify(childInjections))
console.log('  disposed:', `tools=${tools.length} (all released cleanly)`)
