// 新插件入口的**兼容性闸门**核查（DSH V0.1.7-rc.2 新增）。
//
// 事实（读 app-boot/lib/index.js:287 evaluatePluginCompatibility + :2057 preflight）：
//   - 组合期对每个 profile 行调用该函数，不兼容就 `row.disabled = true` 并 stderr 告警
//     —— 插件**整行失效**（fail-closed，且消息里给出 allow-version 补救方式）。
//   - 只读 `peerDependencies` 里 @deepseek-ai/dsh / @deepseek-ai/dsh-* 的项；
//     **不读** `engines.dsh`；没有 peerDependencies 字段时直接放行。
//   - ⚠️ 比较时带 `{ includePrerelease: true }`。这一点很关键：
//     普通 semver 语义下 `>=0.1.5-rc.2` 会**排除** 0.1.7-rc.2，但闸门的语义不会。
//     早期版本的本文档曾据此得出「没有一条范围能同时覆盖两版」的结论——**错误**，
//     因为那个结论用的是 semver 默认语义，而闸门不是默认语义。
//
// 本插件据此**声明** peerDependencies（`@deepseek-ai/dsh-tools` + `@deepseek-ai/cordis`），
// 理由：
//   1. 这就是该字段存在的目的——参与兼容性闸门；不声明等于放弃这层保护；
//   2. 与生态里的既有插件一致（dsh-zgit、dsh-better-sidebar 都声明 harness peers）；
//   3. 已实测 pnpm 11 在 `link:` 与 registry 两种安装下**都不会**拉取这些 peer
//      （profile 里声明了 peer 的 dsh-zgit 也未见 @deepseek-ai 被装进来），
//      故不存在「装出第二份 harness」的双实例风险；
//   4. 本插件确实支持 0.1.5-rc.2 与 0.1.7-rc.2（两侧都实测装配通过）。
//
// 代价（如实记录）：未在范围内验证过的 DSH 版本会 fail-closed（整行 disable），
// 由 `dsh plugin allow-version` / plugin_manager 的版本豁免解除。
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const HERE = import.meta.dirname

/** 找 semver：显式参数 > 已抽取副本 > 从 app.asar 抽一份（与真实运行时同源）。 */
async function resolveSemver() {
  if (process.argv[2]) return createRequire(import.meta.url)(process.argv[2])
  const load = (d) => createRequire(import.meta.url)(d)
  for (const c of [
    process.env.RUNTIME_DIR && join(process.env.RUNTIME_DIR, 'semver'),
    join(tmpdir(), 'dsh-runtime-semver', 'node_modules', 'semver'),
  ].filter(Boolean)) {
    if (existsSync(join(c, 'package.json'))) return load(c)
  }
  const asar = [
    process.env.DSH_ASAR,
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  ].filter(Boolean).find((p) => existsSync(p))
  if (asar) {
    const target = join(tmpdir(), 'dsh-runtime-semver', 'node_modules', 'semver')
    try {
      execFileSync(process.execPath, [
        join(HERE, 'extract-asar-runtime.mjs'), asar, target, 'dsh/node_modules/semver',
      ], { stdio: ['ignore', 'ignore', 'inherit'] })
      if (existsSync(join(target, 'package.json'))) return load(target)
    } catch { /* 落到报错 */ }
  }
  throw new Error('找不到 semver：传入路径参数，或设置 DSH_ASAR / RUNTIME_DIR')
}
const semver = await resolveSemver()

/** 复刻 evaluatePluginCompatibility 的判定部分（注意 includePrerelease）。 */
function incompatiblePeers(manifest, runtimeVersion) {
  if (!Object.hasOwn(manifest, 'peerDependencies')) return undefined
  const peers = {}
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (!semver.satisfies(runtimeVersion, range, { includePrerelease: true })) peers[name] = range
  }
  return Object.keys(peers).length === 0 ? undefined : peers
}

const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))

// 期望：本插件验证过的两版放行；明确未验证的 0.2.x fail-closed。
const EXPECT = [
  ['0.1.5-rc.2', true],
  ['0.1.7-rc.2', true],
  ['0.1.8', true],
  ['0.2.0-rc.1', false],
  ['0.2.0', false],
]

let bad = 0
console.log('--- preflight 放行判定（复刻 evaluatePluginCompatibility）---')
for (const [v, want] of EXPECT) {
  const peers = incompatiblePeers(manifest, v)
  const allowed = peers === undefined
  const ok = allowed === want
  if (!ok) bad++
  console.log(`  dsh ${v.padEnd(11)} -> ${allowed ? 'ALLOW' : 'DENY ' + JSON.stringify(peers)}`
    + (ok ? '' : `   <-- 期望 ${want ? 'ALLOW' : 'DENY'}`))
}

console.log('\n--- 断言 ---')
const peers = manifest.peerDependencies ?? {}
const checks = [
  ['声明了 @deepseek-ai/dsh-tools 的 peer（参与兼容性闸门）',
    typeof peers['@deepseek-ai/dsh-tools'] === 'string'],
  ['声明了 @deepseek-ai/cordis 的 peer', typeof peers['@deepseek-ai/cordis'] === 'string'],
  ['peer 范围用单条 ^0.1.5-rc.2 即可覆盖 0.1.x 全段（闸门带 includePrerelease）',
    peers['@deepseek-ai/dsh-tools'] === '^0.1.5-rc.2'],
  ['未声明 engines.dsh（该字段不被强制检查，声明只增歧义）',
    manifest.engines?.dsh === undefined],
  ['未声明 package.json 顶层 meta（展示元数据只从 locale/*.json 读取）',
    manifest.meta === undefined],
  ['声明了包内相对 icon', typeof manifest.icon === 'string' && manifest.icon.startsWith('./')],
  ['exports 含 "./package.json"', Object.hasOwn(manifest.exports ?? {}, './package.json')],
  ['exports 含 "./locale/*.json"', Object.hasOwn(manifest.exports ?? {}, './locale/*.json')],
  ['声明了 dsh.bundle.patch', typeof manifest.dsh?.bundle?.patch === 'string'],
]
for (const [label, ok] of checks) {
  if (!ok) bad++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
}

console.log(bad === 0
  ? '\nENTRY COMPATIBILITY OK (两版实测版本放行；未验证的 0.2.x fail-closed)'
  : `\n${bad} ENTRY COMPATIBILITY PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
