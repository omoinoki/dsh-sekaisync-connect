// 文档自洽校验：README 里承诺的东西必须与实际代码一致。
// 文档漂移是最难发现的一类回归——没人会跑它，直到用户照着做失败。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFileSync(resolve(root, name), 'utf8')
const pkg = JSON.parse(read('package.json'))
const en = read('README.md')
const zh = read('README.zh-CN.md')
const clientSource = read('lib/client.js')
const panelSource = read('lib/panel.js')

// ── 版本号三处必须一致：package.json / 两个 README 的徽章 ──
// shields.io 的徽章文本把 '-' 写成 '--'（连字符需转义），比较时还原。
const badgeVersion = (text) => {
  const raw = /Release-([0-9][^?]*?)-[0-9A-F]{6}\?style/.exec(text)?.[1]
  return raw === undefined ? undefined : raw.replace(/--/g, '-')
}
assert.equal(badgeVersion(en), pkg.version, `README.md badge (${badgeVersion(en)}) must match package.json (${pkg.version})`)
assert.equal(badgeVersion(zh), pkg.version, `README.zh-CN.md badge (${badgeVersion(zh)}) must match package.json (${pkg.version})`)

// ── 两个 README 必须都提到面板，且锚点与导航链接都存在 ──
for (const [name, text] of [['README.md', en], ['README.zh-CN.md', zh]]) {
  assert.ok(/readme-section-panel/.test(text), `${name} must document the panel section`)
  assert.ok(/href="#readme-section-panel"/.test(text), `${name} navigation must link the panel section`)
  assert.ok(/<a id="readme-section-panel"><\/a>/.test(text), `${name} must declare the panel anchor it links to`)
  // 两个 README 都应列出全部配置文件层，避免只更新一边
  for (const layer of ['config.local.json', 'SEKAISYNC_CONFIG', 'SEKAISYNC_STORE']) {
    assert.ok(text.includes(layer), `${name} must document the ${layer} layer`)
  }
}

// ── 展示用简介：不得夹带「世界计划 / Project Sekai」括号补充 ──
// 客户端（插件面板/设置清单）显示的就是 locale/*/meta.description。
// 「SekaiSync」本身已足够指认，括号补充只会让卡片变长变吵。
const BANNED = [/世界计划/, /世界計畫/, /世界計画/, /Project Sekai/i, /プロセカ/, /プロジェクトセカイ/]
for (const file of ['locale/en.json', 'locale/zh.json']) {
  const parsed = JSON.parse(read(file))
  const description = parsed?.meta?.description
  assert.ok(description, `${file} must carry meta.description (the client shows it)`)
  for (const pattern of BANNED) {
    assert.equal(pattern.test(description), false,
      `${file} description must not contain ${pattern}; got: ${description}`)
  }
}
// package.json 的 description 也会作为兜底显示，同样不得夹带
for (const pattern of BANNED) {
  assert.equal(pattern.test(pkg.description ?? ''), false,
    `package.json description must not contain ${pattern}`)
}

// ── 文档声称的每个面板控件都必须在字典里真实存在 ──
// README 表格里提到的按钮名 → client.js 的字典键
const controls = [
  ['Check', 'check'],
  ['Save and apply', 'save'],
  ['Auto-detect', 'autoDetect'],
  ['Choose folder…', 'chooseFolder'],
  ['Browse', 'browse'],
  ['Test connection', 'test'],
]
for (const [label, key] of controls) {
  assert.ok(en.includes(label), `README must mention the "${label}" control`)
  assert.ok(new RegExp(`\\b${key}:`).test(clientSource), `client dictionary must define "${key}" for "${label}"`)
}

// ── 文档声称的路由前缀与动作必须与代码一致 ──
const hostBase = /const BASE = '([^']+)'/.exec(panelSource)?.[1]
assert.equal(hostBase, '/api/sekaisync')
assert.ok(en.includes(hostBase), `README must name the real route prefix ${hostBase}`)
assert.ok(zh.includes(hostBase), `README.zh-CN.md must name the real route prefix ${hostBase}`)

// 文档说「只接受 POST」「仅限本机」——代码里必须真有对应约束
assert.ok(/methods: \['POST'\]/.test(panelSource), 'routes must declare POST only, as documented')
// 鉴权交给框架的 /api 栅栏（Host/Origin + cookie），而不是自写 remoteAddress 判定。
// 注意：必须先把注释剥掉再判断——解释「为什么不用 remoteAddress」的注释本身含这个词。
const panelCode = panelSource
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
  .replace(/^[ \t]*\/\/.*$/gm, '')    // 行注释
assert.ok(/ctx\.connection\.fetch\.register/.test(panelCode),
  'the panel must use the framework-fenced connection.fetch.register')
assert.equal(/remoteAddress/.test(panelCode), false,
  'must not hand-roll a remoteAddress check: it would break trustedHosts and miss DNS rebinding')
// 源码里必须解释清楚为何选框架栅栏（这是一处非显然的安全取舍）
assert.ok(/DNS rebinding/i.test(panelSource) && /Host\/Origin/.test(panelSource),
  'the reason for using the fenced /api route must be documented in the source')

// 文档说 python 刻意不可编辑——写接口必须真的拒绝它
const deploySource = read('lib/deploy.js')
assert.ok(/不允许写入字段/.test(deploySource), 'deploy must reject non store/root fields as documented')
const writeFn = /export function writeLocalConfig\([\s\S]*?\n}/.exec(deploySource)?.[0] ?? ''
assert.ok(/\['store', 'root'\]\.includes\(key\)/.test(writeFn),
  'writeLocalConfig must gate on exactly the store/root allowlist')
assert.ok(!/python/.test(writeFn), 'writeLocalConfig must not mention python at all')

// ── 文档里的工具名必须与实际注册的 10 个一致 ──
const indexSource = read('lib/index.js')
const registered = [...indexSource.matchAll(/name: '(sekai_[a-z_]+)'/g)].map((m) => m[1])
for (const tool of new Set(registered)) {
  assert.ok(en.includes(tool) || zh.includes(tool), `tool ${tool} should be documented`)
}

// ── 故障排查小节必须提到面板相关的失败模式 ──
assert.ok(/Configure/.test(en), 'English troubleshooting must cover the missing Configure page')
assert.ok(/配置/.test(zh), 'Chinese troubleshooting must cover the missing Configure page')

console.log('docs consistency passed')
console.log('  version   :', pkg.version)
console.log('  panel doc : both READMEs, anchor + nav link present')
console.log('  controls  :', controls.length, 'verified against the dictionary')
console.log('  routes    :', hostBase, '(POST-only, framework-fenced)')
