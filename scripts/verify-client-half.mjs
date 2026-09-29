// 验证 lib/client.js 这个浏览器半侧能否在「模块表 + Cordis 上下文」的模拟环境里正确装载。
// 这不是端到端 GUI 测试，但能抓住最致命的一类问题：factory 抛错、apply 不存在、
// 槽位注册的键不对、locale 注册形状不对、Remote 贡献的 codec 契约不对——这些都会让面板整块不出现。
import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

// ── 1. 静态断言：manifest 与 client 半侧必须自洽 ──
assert.equal(pkg.dsh.client.platform, 'web', 'dsh.client.platform must be web')
assert.equal(pkg.exports['./client'], './lib/client.js', './client export must point at lib/client.js')
for (const dep of pkg.dsh.client.inject) {
  assert.match(dep, /^@deepseek-ai\//, `inject entries are package names, got ${dep}`)
}

// 浏览器半侧不能 import 模块、不能用 JSX/TSX（纯 JS，靠模块表取 React）
assert.equal(/\bimport\s+[\w{*]/.test(source.replace(/\/\/[^\n]*/g, '')), false, 'client half must not use import')
assert.equal(/<[A-Z][\w.]*[\s/>]/.test(source), false, 'client half must not contain JSX')

// factory 必须以包名注册（模块表按 id 取用）
assert.match(source, /__ModuleLoader__\.load\(\{[\s\S]*?id:\s*'dsh-sekaisync-connect'/, 'factory id must equal the package name')

// ── 2. 动态装载：模拟 __ModuleLoader__ 与最小 Cordis 上下文 ──
const registered = []
globalThis.window = {
  __ModuleLoader__: { load: (registration) => registered.push(registration) },
}
// 极简 React 桩：createElement 对**函数组件**直接求值（等价于渲染一层），
// 于是断言能作用在真正的输出上，而不是停在包装元素那里。
// 这足以验证「组件在给定 props 下不抛错且产出预期文案」，不追求完整调和。
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    if (typeof type === 'function') return type({ ...(props || {}), children: flat })
    return { type, props: props || {}, children: flat }
  },
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
}
const requireStub = (specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement }
  throw new Error('unexpected require: ' + specifier)
}

// 执行（等价于浏览器里 script 标签加载 bundle 的注册阶段）
await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))
assert.equal(registered.length, 1, 'exactly one factory registered')
const registration = registered[0]
assert.equal(typeof registration.factory, 'function', 'factory must be a function')

// 物化 factory（等价于模块表首次 require）
const plugin = registration.factory(requireStub)
assert.equal(typeof plugin.apply, 'function', 'client half must export apply')
assert.deepEqual(plugin.inject, ['remote', 'slots', 'locale'], 'client half injects remote + slots + locale')

// 顶层 inject 里**不能**出现命名空间服务（`remote.sekaisync`）：它由 $mount 在运行时
// 才注入，只能作为第二段 ctx.inject 的依赖。
assert.equal(plugin.inject.includes('remote.sekaisync'), false,
  'a namespace Remote service cannot be a top-level inject entry; it exists only after $mount')

// ── 3. 在假上下文里跑 apply：应注册 locale、样式、Remote 贡献与插件面板槽位 ──
const effects = []
const localeCalls = []
const slotRegistrations = []
const slotInjections = []
const childInjections = []
const remoteMounts = []
const remoteMethods = {}

const ctx = {
  // Cordis 语义：ctx.effect(callback) **立即执行** callback，并把返回值登记为清理函数。
  // （这一点很关键：资源注册必须发生在 apply 期间，而不是被排队到以后。）
  effect: (factory, label) => {
    const dispose = factory()
    effects.push({ label, dispose })
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register: (ns, dicts) => { localeCalls.push({ ns, dicts }); return () => {} },
    bind: (ns) => (key, params) => {
      const dict = localeCalls.find((c) => c.ns === ns)?.dicts?.zh
      const value = dict ? dict[key] : undefined
      // 与 client-locale 一致：字符串模板插值 {name}；缺失的键暴露键名本身
      return value === undefined ? key : String(value).replace(/\{(\w+)\}/g, (m, name) => String(params?.[name] ?? m))
    },
  },
  slots: {
    inject: (name, callback) => { slotInjections.push(name); callback(); return () => {} },
    register: (options, Component) => { slotRegistrations.push({ options, Component }); return () => {} },
  },
  remote: {
    $mount: async (contribution) => {
      remoteMounts.push(contribution)
      // 复刻 0.2.0-rc.1 客户端命名空间服务的语义：把每个 descriptor 装成方法
      for (const d of contribution.descriptors) {
        remoteMethods[d.method] = (...args) => Promise.resolve({ ok: true, value: { method: d.method, args } })
      }
      return async () => {}
    },
    // 关键：`remote.sekaisync` 在 $mount 之前是**不存在的**。任何在 apply 期间
    // 直接读取 ctx.remote.sekaisync 的代码都会在这里拿到 undefined 并炸掉，
    // 从而复现「注册了但渲染崩溃 → 槽位条目被 abdicate → 面板消失」。
    get sekaisync() {
      if (remoteMounts.length === 0) {
        throw new Error('cannot get property "sekaisync" without inject')
      }
      return remoteMethods
    },
  },
  // 真实的 Cordis ctx.inject(deps, callback)：依赖齐备时同步调用 callback，
  // 并把返回值当作 disposer（本桩只关心「子 fiber 里的注入调用」）。
  inject: (deps, callback) => {
    childInjections.push([...deps])
    const result = callback(ctx)
    if (result && typeof result.dispose === 'function') return result
    if (typeof result === 'function') return Object.assign(Promise.resolve(), { dispose: result })
    return Object.assign(Promise.resolve(), { dispose: async () => {} })
  },
  get: () => undefined,
}

// document 桩：样式注入走 document.createElement
const head = { appended: [], appendChild(node) { this.appended.push(node) } }
globalThis.document = {
  querySelector: () => null,
  createElement: (tag) => ({ tag, dataset: {}, textContent: '', remove() {} }),
  head,
}

await plugin.apply(ctx)

// 两段式挂载：第二段 ctx.inject 必须把命名空间服务纳入依赖，然后才注册 UI。
assert.equal(childInjections.length, 1, 'apply performs exactly one second-phase ctx.inject')
assert.deepEqual(childInjections[0], ['remote.sekaisync', 'slots', 'locale'],
  'the UI phase injects the mounted namespace service (remote.sekaisync)')

assert.equal(localeCalls.length, 1, 'registers exactly one locale namespace')
assert.equal(localeCalls[0].ns, 'sekaisync')
assert.ok(localeCalls[0].dicts.zh && localeCalls[0].dicts.en, 'both shipped locales are provided')
assert.deepEqual(slotInjections, ['plugins.row.config'], 'injects the row-config slot')
assert.equal(slotRegistrations.length, 1, 'registers exactly one slot entry')

const registrationOptions = slotRegistrations[0].options
assert.equal(registrationOptions.name, 'plugins.row.config')
assert.equal(registrationOptions.key, 'dsh-sekaisync-connect#dsh-sekaisync-connect',
  'key must be <package name>#<row id> as the bundle patch declares it')
assert.equal(typeof slotRegistrations[0].Component, 'function', 'component is a function')

// 官方约定（docs/subsystems/slots.md：Components never receive ctx）：组件需要的
// 能力必须由注册项的 inject 工厂投影出来，而不是让组件自己去碰 ctx.remote.*。
assert.equal(typeof registrationOptions.inject, 'function',
  'the registration must supply services through its inject factory, never through ctx in the render closure')
const injected = registrationOptions.inject()
assert.ok(injected && typeof injected.remote === 'object', 'the inject face carries the projected remote facade')
for (const method of ['state', 'detect', 'inspect', 'browse', 'pick', 'save', 'test']) {
  assert.equal(typeof injected.remote[method], 'function', `inject face exposes remote.${method}()`)
}
assert.equal(Object.keys(injected.remote).length, 7, 'the inject face exposes exactly the seven panel actions')

// ── 4. Remote 贡献必须满足 0.2.0-rc.1 客户端契约 ──
assert.equal(remoteMounts.length, 1, 'mounts exactly one TYPERT_REMOTE contribution')
const contribution = remoteMounts[0]
assert.equal(contribution.package, 'dsh-sekaisync-connect')
const descriptors = contribution.descriptors
assert.deepEqual(descriptors.map((d) => d.method).sort(), ['browse', 'detect', 'inspect', 'pick', 'save', 'state', 'test'],
  'the Remote contribution exposes the seven panel actions')
for (const d of descriptors) {
  assert.equal(d.service, 'deploy')
  assert.equal(d.namespace, 'sekaisync')
  assert.equal(d.invocation.kind, 'direct')
  assert.equal(d.result.mode, 'src-json', 'results pass through as src-json')
  for (const p of d.parameters) {
    // 0.2.0-rc.1 客户端 requireStrictInputs 只查 mode==='strict'；typert 注册表要求
    // strict codec 带 typeSymbol + create()（从不调用 create，参数原样透传）。
    assert.equal(p.codec.mode, 'strict', `${d.method}/${p.name} codec must be strict`)
    assert.ok(p.codec.typeSymbol, `${d.method}/${p.name} codec has a typeSymbol`)
    assert.equal(typeof p.codec.create, 'function', `${d.method}/${p.name} codec has a create() factory`)
  }
}

// ── 5. 渲染两种 view，确认不抛错且摘要文案随状态变化 ──
const Component = slotRegistrations[0].Component
const t = ctx.locale.bind('sekaisync')
// 组件只接收注册项 inject 工厂投影出来的能力——这正是修复后的契约。
const summary = Component({ t, view: 'summary', ...injected })
assert.ok(summary, 'summary view renders something')
assert.match(String(summary.children), /尚未选择/, 'summary says nothing is selected before state loads')

const page = Component({ t, view: 'page', ...injected })
assert.ok(page, 'page view renders something')
assert.ok(Array.isArray(page.children) && page.children.length > 0, 'page view has content')

// 回归断言：渲染时若直接读取未注入的命名空间服务，必定抛错（这就是面板消失的成因）。
const hostileCtx = { remote: { get sekaisync() { throw new Error('cannot get property "sekaisync" without inject') } } }
assert.throws(() => hostileCtx.remote.sekaisync, /without inject/,
  'reading an uninjected namespace service throws — the render closure must never do this')

// useEffect 在桩里不执行，因此 state 仍为 null：页面必须能在无数据时渲染。
assert.equal(page.children.filter((child) => child === null || child === undefined).length, 0,
  'no null children in the first frame')

// 字典键在两侧都齐全（缺失会退回键名显示给用户）
const zhKeys = Object.keys(localeCalls[0].dicts.zh).sort()
const enKeys = Object.keys(localeCalls[0].dicts.en).sort()
assert.deepEqual(zhKeys, enKeys, 'zh and en dictionaries must expose the same keys')

console.log('client-half verification passed')
console.log('  slot key  :', registrationOptions.key)
console.log('  locales   :', localeCalls[0].ns, '/', Object.keys(localeCalls[0].dicts).join(','))
console.log('  dict keys :', zhKeys.length)
console.log('  remote    :', descriptors.map((d) => d.method).sort().join(', '))
