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
import { DeployService, NAMESPACE, registerRemoteMethods } from '../lib/deploy-service.js'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { getPluginRoot } from '../lib/backend.js'

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
    if (previous === undefined) delete process.env.SEKAISYNC_CONFIG_DIR
    else process.env.SEKAISYNC_CONFIG_DIR = previous
  } }
}

test('DeployService exposes the seven panel actions as Remote methods', () => {
  registerRemoteMethods(DeployService, ['state', 'detect', 'inspect', 'browse', 'pick', 'save', 'test'])
  const methods = remoteMethods(Object.create(DeployService.prototype)).map((m) => m.method)
  assert.deepEqual(methods.sort(), ['browse', 'detect', 'inspect', 'pick', 'save', 'state', 'test'])
  assert.equal(NAMESPACE, 'sekaisync')
})

test('state reports effective values and parsed candidates', () => {
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
    assert.ok(Array.isArray(state.candidates))
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

test('browse lists subdirectories with breadcrumbs and rejects an unusable path', () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  mkdirSync(join(pluginRoot, 'inner', 'deep'), { recursive: true })
  writeFileSync(join(pluginRoot, 'inner', 'file.txt'), 'x')
  const { service, restore } = makeService({ pluginRoot })
  try {
    const listing = service.browse(pluginRoot)
    assert.equal(listing.path, pluginRoot)
    const names = listing.entries.map((e) => e.name)
    assert.ok(names.includes('inner'))
    assert.equal(names.includes('file.txt'), false, 'only directories are listed')
    assert.ok(listing.crumbs.length >= 1)

    assert.throws(() => service.browse(join(pluginRoot, 'nope')))
  } finally { restore(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('pick degrades gracefully when no directory picker is mounted', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  const { service, restore } = makeService({ pluginRoot })
  try {
    const result = await service.pick()
    assert.equal(result.available, false)
    assert.equal(result.reason, 'no-picker')
  } finally { restore(); rmSync(pluginRoot, { recursive: true, force: true }) }
})

test('pick opens a native chooser when present and reports cancellation', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sks-panel-'))
  let behaviour = { kind: 'native', pick: async () => null }
  const { service, restore } = makeService({ pluginRoot, picker: { capability: () => behaviour } })
  try {
    const cancelled = await service.pick()
    assert.equal(cancelled.available, true)
    assert.equal(cancelled.cancelled, true)

    behaviour = { kind: 'browse', list: async () => ({}) }
    const browseMode = await service.pick()
    assert.equal(browseMode.available, false, 'browse mode does not open an OS dialog')

    behaviour = { kind: 'native', pick: async () => pluginRoot }
    const chosen = await service.pick()
    assert.equal(chosen.cancelled, false)
    assert.equal(chosen.path, pluginRoot)
    assert.ok(chosen.inspected, 'the chosen path is classified for the panel')
  } finally { restore(); rmSync(pluginRoot, { recursive: true, force: true }) }
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
