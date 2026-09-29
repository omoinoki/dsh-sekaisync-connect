// 版本闸门校验：用运行时**自己的** evaluatePluginCompatibility 实现，
// 对若干 DSH 版本逐一判定，并把结论与 README 里声明的兼容表对齐。
//
// 为什么单独做这件事：DSH 的插件闸门是 fail-closed 的——只要 peerDependencies 里
// 某个 `@deepseek-ai/dsh-*` 范围不满足运行时版本，插件会被整体禁用（工具全部消失、
// 面板也不加载）。这类故障对用户表现为「插件突然失效」，但错误信息在别处，很难定位。
// 这里把它变成一条可复跑的断言。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ── 1. 从本机运行的 DSH（app.asar）里取运行时版本与闸门实现 ──
const appBoot = process.env.TEMP + '\\pm020\\appboot'
if (!existsSync(appBoot)) throw new Error('缺少抽取目录；先运行 scripts/extract-asar-runtime.mjs 抽取 @deepseek-ai/dsh-app-boot')

const runtimeVersion = JSON.parse(readFileSync(join(appBoot, 'package.json'), 'utf8')).version
console.log('runtime (本机 DSH)        :', runtimeVersion)
console.log('plugin                   :', `${manifest.name}@${manifest.version}`)
console.log('peerDependencies         :', JSON.stringify(manifest.peerDependencies))

// 把运行时的闸门实现切出来，在能解析 semver 的位置求值（避免复制粘贴失真）
const src = readFileSync(join(appBoot, 'lib', 'index.js'), 'utf8')
const start = src.indexOf('function evaluatePluginCompatibility(')
if (start < 0) throw new Error('运行时里找不到 evaluatePluginCompatibility')
const end = src.indexOf('\n}\n', start) + 3
const impl = src.slice(start, end)

const scratch = mkdtempSync(join(tmpdir(), 'sks-gate-'))
try {
  const semverDir = process.env.SEKAISYNC_SEMVER_DIR || (process.env.TEMP + '\\gaterun\\node_modules\\semver')
  if (!existsSync(semverDir)) throw new Error(`找不到 semver（${semverDir}）；先抽取它`)
  const require = createRequire(join(semverDir, 'package.json'))
  const implFile = join(scratch, 'gate.mjs')
  writeFileSync(implFile, `
import semver from ${JSON.stringify('file:///' + semverDir.replace(/\\/g, '/') + '/index.js')}
function objectOf$1(v,f){ if(typeof v!=="object"||v===null||Array.isArray(v)) throw new Error(f+" must be an object"); return v }
function runtimeVersionOf(v){ if(typeof v!=="string"||semver.valid(v)===null) throw new Error("Invalid dsh runtime version"); return v }
function identityField(m,f){ const v=Object.hasOwn(m,f)?m[f]:void 0; if(typeof v!=="string"||v.trim()==="") throw new Error("Plugin manifest "+f+" must be a non-empty string"); return v }
${impl}
export { evaluatePluginCompatibility }
`, 'utf8')
  const { evaluatePluginCompatibility } = await import('file:///' + implFile.replace(/\\/g, '/'))
  const semver = require('semver')

  // ── 2. 本机运行版本必须通过 ──
  const current = evaluatePluginCompatibility(manifest, {}, runtimeVersion)
  if (current !== undefined) {
    throw new Error(
      `插件会被本机 DSH ${runtimeVersion} 禁用：不兼容的 peer ${JSON.stringify(current.peers)}\n` +
      `  → 放宽 package.json 的 peerDependencies，或用 dsh plugin allow-version 显式授权。`)
  }
  console.log(`\n✅ 本机 ${runtimeVersion}：闸门通过`)

  // ── 3. 声明区间：0.2.x 放行，0.1.x 与 0.3.x 保持 fail-closed ──
  const expectations = [
    ['0.1.5-rc.2', false], ['0.1.7-rc.2', false], ['0.1.8', false],
    ['0.2.0-rc.1', true], ['0.2.0', true], ['0.2.1', true], ['0.2.9', true],
    ['0.3.0', false], ['0.3.0-rc.1', false], ['1.0.0', false], ['0.1.4', false],
  ]
  console.log('\n=== 各版本闸门判定 ===')
  let failures = 0
  for (const [version, expected] of expectations) {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    const allowed = issue === undefined
    const mark = allowed === expected ? 'OK  ' : 'FAIL'
    if (allowed !== expected) failures++
    console.log(`  ${mark} ${version.padEnd(12)} allow=${String(allowed).padEnd(5)} (expected ${expected})`)
  }
  if (failures > 0) throw new Error(`${failures} 个版本的闸门结果与声明不符`)

  // ── 4. 与 README 声明的兼容表对齐 ──
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const rowFor = (version) => new RegExp(`\\|\\s*\`${version.replace(/\./g, '\\.')}\`[^|]*\\|\\s*(allow|\\*\\*DENY\\*\\*)`).exec(readme)
  for (const [version, expected] of expectations.filter(([v]) => v === '0.1.5-rc.2' || v === '0.1.7-rc.2' || v === '0.1.8' || v === '0.2.0-rc.1' || v === '0.2.0' || v === '0.3.0')) {
    const row = rowFor(version)
    if (!row) { console.log(`  (README 未列出 ${version}，跳过比对)`); continue }
    const allows = row[1] === 'allow'
    if (allows !== expected) {
      throw new Error(`README 兼容表与闸门不一致：${version} 表中=${row[1]} 闸门=${expected ? 'allow' : 'deny'}`)
    }
  }
  console.log('\n✅ README 兼容表与闸门一致')
  console.log('\nversion-gate verification passed')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
