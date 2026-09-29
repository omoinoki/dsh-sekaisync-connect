// dsh-sekaisync-connect —— 部署路径的面板后端（Cordis 服务 + Typert Remote）。
//
// 参照官方 dsh-experimental-voice-input-bundle 的做法，但适配了「零构建、纯 ESM」：
//   - 官方用 `@Remote` 装饰器标记方法（tsdown 编译后的 stage-3 装饰器），
//     Node 24 原生不支持装饰器语法，而本插件不经过编译。
//     实测（见 registerRemoteMethods 注释）导出的 `Remote(name)` 是普通函数，只要按
//     ES 装饰器协议手动调用它，就能在原型上打出同样的标记，`remoteMethods()` 照常读到。
//     → 这里用 registerRemoteMethods() 手动打标，不引入构建步骤。
//   - 持久化走 ctx.settings.update(entryId, patch)：写进 profile 的 cordis.patch.yml，
//     由 config-editor 管理——升级不覆盖、写后热加载、并发写串行化、非法值写前即拒。
//     这是「官方正确的位置」；手写 config.local.json 会随插件目录一起在重装时丢失。
//   - 读写只针对 Config 里的 .volatile() 字段（store / root）。python 是可执行文件路径，
//     刻意不 volatile——把它暴露成可编辑表单等于把「任意程序执行」放到网页上。
//
// 关键约束（来自 0.2.0-rc.1 的 dsh-api-gateway SRC 回退路径，见 verify-host-half）：
//   网关在没有严格定义（strict reflection）时会走 SRC 回退，用 Function.prototype.toString
//   解析方法参数名，因此这里的方法**必须用单一标识符形参**（不能解构、不能带默认值、
//   不能有 rest）。这正是下方 state()/detect()/inspect(path)/browse(path)/save(store) 用
//   位置参数而非 { ... } 的原因。
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { classifyPath } from './deploy.js'
import { call, ensureServer, loadConfig, resolveStore, setConfigOverride } from './backend.js'

/** Remote 命名空间：浏览器半侧以 ctx.remote.sekaisync.<method>() 调用。 */
export const NAMESPACE = 'sekaisync'

/**
 * 在类原型上手动打 Remote 方法标记（等价于 @Remote 装饰器）。
 * 原理：Remote(name) 返回一个标准 ES 方法装饰器 `(method, context) => addMarkerInitializer(...)`；
 * addMarkerInitializer 要求 context 带 name/private/static/addInitializer，并在 initializer
 * 里 `mark(Object.getPrototypeOf(this), …)`——即 this 必须是「类的实例」。
 * 这里用一个 Object.create(proto) 的伪实例复刻该语义。
 */
export function registerRemoteMethods(cls, names) {
  for (const name of names) {
    const decorator = Remote(name)
    decorator(cls.prototype[name], {
      name,
      private: false,
      static: false,
      addInitializer(initializer) {
        initializer.call(Object.create(cls.prototype))
      },
    })
  }
  return cls
}

/** 组装面板需要的当前状态（只读）。 */
function buildState() {
  const cfg = loadConfig()
  let resolved = null
  let resolveError = null
  try { resolved = resolveStore(cfg) } catch (e) { resolveError = String(e.message || e) }
  return {
    store: cfg.store || '',
    root: cfg.root || '',
    python: cfg.python || 'python',
    externalPort: Number(cfg.externalPort) || 8787,
    resolvedStore: resolved,
    resolveError,
    current: cfg.store ? classifyPath(cfg.store) : null,
  }
}

class DeployServiceImpl extends TypertRemoteService {
  static inject = ['settings']
  config
  entryId

  constructor(ctx, config) {
    super(ctx, 'deploy', { namespace: NAMESPACE })
    this.config = config
    // ctx.fiber.entry 由 loader 注入：本服务通过 settingsCtx.plugin(DeployService) 装载，
    // 装载它的 fiber 是「本插件的 profile 行」那个 fiber（child fiber 继承 entry）。
    // 用逐级上溯兜底，确保拿到 options.id 而非 undefined。
    this.entryId = locateEntryId(ctx)
  }

  /** 当前部署状态 + 可用性复核（只读）。 */
  state() {
    return buildState()
  }

  /** 判定一个路径是不是可用的 SekaiSync 部署（只读）。面板用它做实时预览。 */
  inspect(path) {
    return classifyPath(path)
  }

  /**
   * 保存：分类校验 → settings.update 写 profile patch（只写 store/root）。
   * root 由 store 反推（classifyPath 已给出 root），因此面板只传 store 一个参数；
   * 这既贴合 SRC 回退的「单一标识符形参」约束，也把可编辑面收敛到「只选 store」。
   * 返回保存后的生效值，供面板立即回显。
   */
  async save(store) {
    const inspected = classifyPath(store)
    if (!inspected.ok) throw new Error(`store 校验未通过：${inspected.message || inspected.reason}`)
    const settings = this.ctx.get('settings')
    const entryId = this.entryId
    if (settings === undefined || entryId === undefined) {
      throw new Error('保存需要 Settings 服务与一个可寻址的 profile 行；当前组合不满足。')
    }
    const patch = { store: inspected.store, root: inspected.root }
    await settings.update(entryId, patch)
    // settings.update 对 volatile-only 变更**不重启插件行**，只把新值就地写进
    // Volatile 引用并异步发 loader/volatile-update。这里立刻把新值并进运行时覆盖层，
    // 让紧随其后的 state() 就返回新值，面板无需等事件或重开页面。
    setConfigOverride(patch)
    return { ok: true, store: patch.store, root: patch.root, verified: inspected }
  }

  /** 试连：用当前配置真实打一次上游，把「选对了没有」变成可观察事实。 */
  async test() {
    const started = Date.now()
    try {
      const cfg = loadConfig()
      const store = resolveStore(cfg)
      // 健康检查在根路径 /health，**不是** /api/v1/health（实测 404）。
      const meta = await ensureServer()
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 60_000)
      let health
      try {
        const response = await fetch(`http://127.0.0.1:${meta.port}/health`, { signal: ctrl.signal, redirect: 'error' })
        health = await response.json()
      } finally { clearTimeout(timer) }
      let freshness = null
      let freshnessError = null
      try {
        freshness = await call('freshness', null, { timeoutMs: 60_000, noCache: true })
      } catch (e) { freshnessError = String(e.message || e) }
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        store,
        mode: meta.external ? 'external' : 'managed',
        healthy: !!(health && health.status === 'ok'),
        ready: !!(health && health.ready === true),
        upstream: health ?? null,
        freshness,
        freshnessError,
      }
    } catch (e) {
      return { ok: false, elapsedMs: Date.now() - started, error: String(e.message || e) }
    }
  }
}

/** 逐级上溯 fiber 找到本插件的 loader 行 id（settings.update 的命名空间）。 */
function locateEntryId(ctx) {
  let fiber = ctx.fiber
  while (fiber) {
    if (fiber.entry?.options?.id) return fiber.entry.options.id
    const next = fiber.parent?.fiber
    if (!next || next === fiber) break
    fiber = next
  }
  return undefined
}

registerRemoteMethods(DeployServiceImpl, ['state', 'inspect', 'save', 'test'])

export { DeployServiceImpl as DeployService }
export default DeployServiceImpl
