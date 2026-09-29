// 面板的端到端校验：用**本机真实配置**（真实 2 GiB+ store）跑一遍面板动作。
//
// 只读原则：state / inspect 都是只读的。
// save 会写 settings，因此它在**临时配置目录**里验证（SEKAISYNC_CONFIG_DIR 指向副本），
// 并在结束时断言仓库里的真实 config.local.json 逐字节未变。
//
// 本脚本同时是「面板迁移到 Typert Remote + settings 之后仍然工作」的回归防线。
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeployService } from '../lib/deploy-service.js'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { setConfigOverride, setRuntimeConfig } from '../lib/backend.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const realConfigPath = join(root, 'config.local.json')
const realBefore = existsSync(realConfigPath) ? readFileSync(realConfigPath) : null

// Remote 面必须只剩四个与权限无关的动作。
assert.deepEqual(remoteMethods(Object.create(DeployService.prototype)).map((m) => m.method).sort(),
  ['inspect', 'save', 'state', 'test'])

/** 在最小上下文里构造一个 DeployService，配置目录可重定向。 */
function makeService(configDir, { collectUpdates = false } = {}) {
  const previous = process.env.SEKAISYNC_CONFIG_DIR
  if (configDir) process.env.SEKAISYNC_CONFIG_DIR = configDir
  const updates = []
  const settings = { update: async (ns, patch) => { updates.push({ ns, patch }) } }
  const service = Object.create(DeployService.prototype)
  service.ctx = {
    fiber: { entry: { options: { id: 'dsh-sekaisync-connect' } } },
    get: (name) => (name === 'settings' ? settings : undefined),
  }
  service.entryId = 'dsh-sekaisync-connect'
  service.config = {}
  return {
    service, updates,
    restore: () => {
      setConfigOverride(null)
      setRuntimeConfig(null)
      if (previous === undefined) delete process.env.SEKAISYNC_CONFIG_DIR
      else process.env.SEKAISYNC_CONFIG_DIR = previous
    },
  }
}

const line = (label, value) => console.log(`  ${String(label).padEnd(14)} ${value}`)

// ── 1. 只读动作：对真实部署 ──
const live = makeService(undefined)
try {
  const state = live.service.state()

  console.log('=== state（真实配置）===')
  line('store', state.store)
  line('root', state.root)
  line('current', state.current ? `ok=${state.current.ok} kind=${state.current.kind}` : 'null')
  line('database', state.current ? `${state.current.databaseBytes} bytes / ${state.current.kbEntries} kb entries` : '-')

  // 这台机器上的真实部署应当被识别出来（否则面板会误导用户）
  assert.ok(state.resolvedStore, `the real deployment must resolve, got error: ${state.resolveError}`)
  assert.equal(state.current.ok, true, 'the effective store must classify as usable')
  assert.equal(state.current.hasDatabase, true, 'the real store has a database')
  assert.ok(state.current.databaseBytes > 1024 * 1024, 'the real database is non-trivial in size')

  // inspect 仍然工作；它同时是面板实时预览的后端。
  const inspect = live.service.inspect(state.store)
  assert.equal(inspect.ok, true)
  assert.equal(inspect.store, state.store)

  console.log('\n=== inspect（面板实时预览用的同一函数）===')
  line('inspect', `kind=${inspect.kind} ok=${inspect.ok}`)
  line('derived root', inspect.root)
} finally { live.restore() }

// ── 2. 写动作：在临时配置目录里验证，绝不动真实文件 ──
const scratch = mkdtempSync(join(tmpdir(), 'sks-e2e-'))
try {
  // 用真实配置的副本作为起点，验证「写入保留其它键」（settings 语义是 patch，非整段替换）
  if (realBefore) copyFileSync(realConfigPath, join(scratch, 'config.local.json'))
  writeFileSync(join(scratch, 'config.json'), JSON.stringify({ store: null, root: null, python: 'python', externalPort: 8787 }))

  const scratchSvc = makeService(scratch, { collectUpdates: true })
  try {
    const state = scratchSvc.service.state()
    const realStore = state.store
    const realRoot = state.root

    // 保存一个真实可用的路径
    const saved = await scratchSvc.service.save(realStore)
    assert.equal(saved.ok, true)

    // settings.update 收到的必须是 store + 派生 root，且命名空间是本插件的行 id
    assert.equal(scratchSvc.updates.length, 1)
    assert.equal(scratchSvc.updates[0].ns, 'dsh-sekaisync-connect')
    assert.equal(scratchSvc.updates[0].patch.store, realStore)
    assert.equal(scratchSvc.updates[0].patch.root, realRoot, 'root is derived from the store when omitted')

    console.log('\n=== save（临时配置目录）===')
    line('saved store', saved.store)
    line('saved root', saved.root)

    // 关键回归：保存之后 state() 必须立刻报出新值（既不等 volatile 事件，也不等重启）。
    const after = scratchSvc.service.state()
    assert.equal(after.store, realStore, 'state() reflects the saved store immediately')
    assert.equal(after.root, realRoot, 'state() reflects the saved root immediately')
    line('state after', `store=${after.store === realStore} root=${after.root === realRoot}`)

    // 无效路径必须被拒
    await assert.rejects(() => scratchSvc.service.save(join(scratch, 'nope')), /store 校验未通过/)
    assert.equal(scratchSvc.updates.length, 1, 'a rejected save must not reach settings.update')
    line('invalid save', 'rejected (no settings.update)')
  } finally { scratchSvc.restore() }
} finally { rmSync(scratch, { recursive: true, force: true }) }

// ── 3. 真实配置必须逐字节未变 ──
if (realBefore !== null) {
  const realAfter = readFileSync(realConfigPath)
  assert.ok(realBefore.equals(realAfter), 'the repository config.local.json must be untouched')
}
console.log('\n=== 安全性 ===')
line('real config', realBefore === null ? '(absent, unchanged)' : 'untouched (byte-identical)')
console.log('\npanel end-to-end verification passed')
