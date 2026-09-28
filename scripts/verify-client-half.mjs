// 验证 lib/client.js 这个浏览器半侧能否在「模块表 + Cordis 上下文」的模拟环境里正确装载。
// 这不是端到端 GUI 测试，但能抓住最致命的一类问题：factory 抛错、apply 不存在、
// 槽位注册的键不对、locale 注册形状不对——这些都会让面板整块不出现。
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
assert.deepEqual(plugin.inject, ['slots', 'locale'], 'client half injects slots + locale')

// ── 3. 在假上下文里跑 apply：应注册 locale、样式与插件面板槽位 ──
const effects = []
const localeCalls = []
const slotRegistrations = []
const slotInjections = []

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
      if (typeof value === 'function') return value(params || {})
      // 与 client-locale 一致：缺失的键暴露键名本身，便于发现遗漏
      return value === undefined ? key : value
    },
  },
  slots: {
    inject: (name, callback) => { slotInjections.push(name); callback(); return () => {} },
    register: (options, Component) => { slotRegistrations.push({ options, Component }); return () => {} },
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
globalThis.fetch = async () => { throw new Error('fetch must not run during apply') }

plugin.apply(ctx)

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

// ── 4. 渲染两种 view，确认不抛错且摘要文案随状态变化 ──
const Component = slotRegistrations[0].Component
const t = ctx.locale.bind('sekaisync')
const summary = Component({ t, view: 'summary' })
assert.ok(summary, 'summary view renders something')
assert.match(String(summary.children), /尚未选择/, 'summary says nothing is selected before state loads')

const page = Component({ t, view: 'page' })
assert.ok(page, 'page view renders something')
assert.ok(Array.isArray(page.children) && page.children.length > 0, 'page view has content')

// useEffect 在桩里不执行，因此 state 仍为 null：页面必须能在无数据时渲染。
// 这正是真实首帧的情形（组件挂载后才会 fetch）——不能因为 state 为空就抛错。
assert.equal(page.children.filter((child) => child === null || child === undefined).length, 0,
  'no null children in the first frame')

// 字典键在两侧都齐全（缺失会退回键名显示给用户）
const zhKeys = Object.keys(localeCalls[0].dicts.zh).sort()
const enKeys = Object.keys(localeCalls[0].dicts.en).sort()
assert.deepEqual(zhKeys, enKeys, 'zh and en dictionaries must expose the same keys')

// ── 5. 契约核对：client 调用的动作名必须正是 host 注册的路由 ──
// 这是最容易「看起来都对、实际 404」的地方：两边各自写字符串，谁也不会编译报错。
const panelSource = readFileSync(resolve(root, 'lib/panel.js'), 'utf8')
const hostActions = new Set(
  [...panelSource.matchAll(/^\s{2}([a-zA-Z]+):\s*(?:async\s*)?\(/gm)].map((m) => m[1]),
)
const clientActions = new Set([...source.matchAll(/api\(\s*'([a-zA-Z]+)'/g)].map((m) => m[1]))
assert.ok(hostActions.size > 0, 'host action table parsed')
assert.ok(clientActions.size > 0, 'client call sites parsed')
for (const action of clientActions) {
  assert.ok(hostActions.has(action), `client calls api('${action}') but the host declares no such route`)
}
// 反向：host 的每个动作都应在 client 里可达
for (const action of hostActions) {
  assert.ok(clientActions.has(action), `host route '${action}' is never called by the client half`)
}

// 面板前缀必须一致，且**必须是文档相对**的（应用可能挂在子路径下）。
// 框架还硬性要求 host 侧路径落在 /api 内。
const hostBase = /const BASE = '([^']+)'/.exec(panelSource)?.[1]
const hostRelative = /const RELATIVE_BASE = ([^\n]+)/.exec(panelSource)?.[1]
const clientBase = /const API = '([^']+)'/.exec(source)?.[1]
assert.equal(clientBase, hostBase.slice(1),
  'client prefix must be the document-relative form of the host route prefix')
assert.equal(clientBase.startsWith('/'), false, 'the client must not use an absolute path')
assert.ok(hostBase.startsWith('/api/'), 'framework requires host routes under /api')
assert.ok(/BASE\.slice\(1\)/.test(hostRelative ?? ''), 'the relative prefix derives from the same literal')

console.log('client-half verification passed')
console.log('  slot key  :', registrationOptions.key)
console.log('  locales   :', localeCalls[0].ns, '/', Object.keys(localeCalls[0].dicts).join(','))
console.log('  dict keys :', zhKeys.length)
console.log('  host base :', hostBase, '(under /api as the framework requires)')
console.log('  client    :', clientBase, '(document-relative)')
console.log('  actions   :', [...hostActions].sort().join(', '))
