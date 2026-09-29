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
const deployServiceSource = read('lib/deploy-service.js')

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

// ── 面板架构必须与代码一致：Typert Remote + settings 持久化 ──
// 文档说「面板后端是 Typert Remote 服务、写入走 settings.update」——代码里必须真这么做。
assert.ok(/ctx\.remote\.sekaisync/.test(clientSource), 'client must call the sekaisync Remote namespace')
assert.ok(/TYPERT_REMOTE/.test(clientSource), 'client must hand-ship a TYPERT_REMOTE contribution')
assert.ok(/ctx\.remote\.\$mount/.test(clientSource), 'client must mount the Remote contribution')
assert.ok(/settings\.update/.test(deployServiceSource), 'panel writes must go through settings.update')
assert.ok(/ctx\.get\('settings'\)/.test(deployServiceSource), 'the service must read the settings service')
// 面板不再手写 HTTP 路由：既没有 panel.js，也没有 connection.fetch.register
assert.ok(!/connection\.fetch/.test(deployServiceSource), 'must not hand-roll HTTP routes anymore')
assert.ok(!/remoteAddress/.test(deployServiceSource), 'must not hand-roll a remoteAddress check')

// 文档说 python 刻意不可编辑——写接口必须真的拒绝它
// （config 里 python 不 .volatile()，save 也只写 store/root 两个字段）
const configSource = read('lib/config.js')
assert.ok(!/python[^\n]*\.volatile\(\)/.test(configSource), 'python must NOT be volatile')
assert.ok(/store[^\n]*\.volatile\(\)/.test(configSource), 'store must be volatile')
assert.ok(/root[^\n]*\.volatile\(\)/.test(configSource), 'root must be volatile')
assert.ok(/VOLATILE_FIELDS\s*=\s*\[[^\]]*'store'[^\]]*'root'/.test(configSource),
  'the editable allowlist must be store/root')

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
console.log('  panel arch:', 'Typert Remote (`sekaisync`) + settings.update persistence')
