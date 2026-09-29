// 面板后端的单元测试：DeployService（Typert Remote 服务）的动作。
// 迁移到官方 settings + Typert Remote 机制之后，不再有 HTTP 路由：
//   - 面板后端是一个 DeployService（extends TypertRemoteService，命名空间 `sekaisync`），
//     方法带 @Remote 等价标记（registerRemoteMethods 手动打标）。
//   - 持久化走 ctx.settings.update(entryId, patch)，由框架的 config-editor 落盘
//     （写 profile 的 cordis.patch.yml，升级不覆盖、写后热加载）。
// 因此这里用最小 Cordis 上下文直接调服务方法，离线验证动作与安全闸门。
// 全程离线（test 动作用假 store 必然失败，正好验证失败信封）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeployService, NAMESPACE } from '../lib/deploy-service.js'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { getPluginRoot, onVolatileUpdate, setConfigOverride, setRuntimeConfig } from '../lib/backend.js'

// 安全前提：这些测试绝不能写到真实的插件 config.local.json。
// 它们全部依赖 SEKAISYNC_CONFIG_DIR 把配置目录指向临时目录；这里先断言该机制可用。
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

/** 在最小上下文里构造一个 DeployService 实例，并记录 settings.update 调用。 */
function makeService({ pluginRoot, entryId = 'dsh-sekaisync-connect', picker } = {}) {
  const previous = process.env.SEKAISYNC_CONFIG_DIR
  if (pluginRoot) process.env.SEKAISYNC_CONFIG_DIR = pluginRoot
  const updates = []
  const settings = { update: async (ns, patch) => { updates.push({ ns, patch }) } }
  const ctx = {
    fiber: { entry: { options: { id: entryId } } },
    get: (name) => (name === 'settings' ? settings : name === 'directoryPicker' ? picker : undefined),
    reflect: { provide: () => () => {} },
    root: {},
    effect: () => () => {},
  }
  // 绕过 Cordis 的构造副作用（reflect.provide 需要完整 root），只跑我们的逻辑：
  // 直接以原型实例 + 手动赋 ctx/entryId/settings 的方式构造。
  const service = Object.create(DeployService.prototype)
  service.ctx = ctx
  service.entryId = entryId
  service.config = {}
  return { service, updates, restore: () => {
    // save() 会写入模块级的乐观覆盖层与 runtime 层；两者都是跨测试残留的状态，
    // 必须在每个用例结束时清干净，否则后面的用例会读到上一个用例的 store。
    setConfigOverride(null)
    setRuntimeConfig(null)
    if (previous === undefined) delete process.env.SEKAISYNC_CONFIG_DIR
    else process.env.SEKAISYNC_CONFIG_DIR = previous
  } }
}

test('DeployService exposes exactly the four panel actions as Remote methods', () => {
  const methods = remoteMethods(Object.create(DeployService.prototype)).map((m) => m.method)
  assert.deepEqual(methods.sort(), ['inspect', 'save', 'state', 'test'])
  assert.equal(NAMESPACE, 'sekaisync')
  // 自动探测 / 浏览 / 选择文件夹依赖宿主侧的目录级权限，已随面板按钮一并移除；
  // 它们绝不能悄悄回到 Remote 面上。
  for (const gone of ['detect', 'browse', 'pick']) {
    assert.equal(methods.includes(gone), false, `${gone} must not be exposed any more`)
  }
})

test('state reports effective values without probing the filesystem for candidates', () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { root, store } = makeDeployment(pluginRoot)
  writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null, root: null, python: 'python', externalPort: 8787 }))
  writeFileSync(join(pluginRoot, 'config.local.json'), JSON.stringify({ store, root }))
  const { service, restore } = makeService({ pluginRoot })
  try {
    const state = service.state()
    assert.equal(state.store, store)
    assert.equal(state.root, root)
    assert.equal(state.current.ok, true)
    assert.equal(state.current.hasDatabase, true)
    assert.equal('candidates' in state, false, 'state no longer scans for candidate deployments')
  } finally { restore(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('inspect classifies a repo root and rejects a plain directory with a reason', () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { root, store } = makeDeployment(pluginRoot)
  const plain = join(pluginRoot, 'plain')
  mkdirSync(plain)
  const { service, restore } = makeService({ pluginRoot })
  try {
    const good = service.inspect(root)
    assert.equal(good.ok, true)
    assert.equal(good.store, store)
    assert.equal(good.kind, 'repo-root')

    const bad = service.inspect(plain)
    assert.equal(bad.ok, false)
    assert.equal(bad.reason, 'no-store-found')
  } finally { restore(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('save validates, derives root from store, and writes store/root through settings.update', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { root, store } = makeDeployment(pluginRoot)
  writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null, root: null, python: 'python', externalPort: 8787 }))
  const { service, updates, restore } = makeService({ pluginRoot })
  try {
    const result = await service.save(store)
    assert.equal(result.ok, true)
    assert.equal(result.store, store)
    assert.equal(result.root, root, 'root is derived when omitted')

    assert.equal(updates.length, 1)
    assert.equal(updates[0].ns, 'dsh-sekaisync-connect')
    assert.equal(updates[0].patch.store, store)
    assert.equal(updates[0].patch.root, root)
  } finally { restore(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('save refuses an invalid path rather than pointing the KB at a broken directory', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { root } = makeDeployment(pluginRoot)
  writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null }))
  const { service, updates, restore } = makeService({ pluginRoot })
  try {
    await assert.rejects(() => service.save(join(root, 'does-not-exist')), /store 校验未通过/)
    assert.equal(updates.length, 0, 'a rejected save must not reach settings.update')
  } finally { restore(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

// ── 修复回归：保存后「生效 store / 生效 root」必须立刻变，而不是等重启 ──
// settings.update 对 volatile-only 变更不会重新 apply，只就地改写 Volatile 引用
// 并异步发 loader/volatile-update。若 state() 读的是 apply 那一刻的快照，
// 面板会一直显示旧路径。这里断言 save 之后 state() 立即反映新值。

test('save makes state() report the new store immediately, without a plugin restart', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const first = makeDeployment(join(pluginRoot, 'a'))
  const second = makeDeployment(join(pluginRoot, 'b'))
  writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null, root: null }))
  writeFileSync(join(pluginRoot, 'config.local.json'), JSON.stringify({ store: first.store, root: first.root }))
  const { service, updates, restore } = makeService({ pluginRoot })
  try {
    assert.equal(service.state().store, first.store, 'starts on the first deployment')

    await service.save(second.store)

    assert.equal(updates.length, 1, 'the write reached settings.update')
    // 关键断言：同一进程、同一实例，没有重新 apply，state() 已是新值。
    assert.equal(service.state().store, second.store, 'state() reflects the saved store at once')
    assert.equal(service.state().root, second.root, 'and the derived root too')
  } finally { restore(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('a saved store survives the volatile-update event that clears the optimistic overlay', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { root, store } = makeDeployment(pluginRoot)
  writeFileSync(join(pluginRoot, 'config.json'), JSON.stringify({ store: null, root: null }))
  const { service, restore } = makeService({ pluginRoot })
  try {
    // 模拟真实时序：Volatile 引用随后才被 loader 更新。
    setRuntimeConfig({ store: { get: () => store }, root: { get: () => root } })
    await service.save(store)
    onVolatileUpdate()
    assert.equal(service.state().store, store, 'the authoritative value comes from the Volatile refs')
    assert.equal(service.state().root, root)
  } finally {
    setRuntimeConfig(null)
    setConfigOverride(null)
    restore(); rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test('test action returns a structured failure instead of throwing when the store is unusable', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  // 指向一个不存在的 store，让调用必然失败——但返回的是结构化失败而非抛出
  writeFileSync(join(pluginRoot, 'config.local.json'), JSON.stringify({ store: join(pluginRoot, 'gone'), root: pluginRoot }))
  const { service, restore } = makeService({ pluginRoot })
  try {
    const result = await service.test()
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.length > 0)
  } finally { restore(); rmSync(pluginRoot, { recursive: true, force: true }) }
})
