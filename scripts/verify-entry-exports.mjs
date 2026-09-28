// 负向验证：0.1.7-rc.2 的新插件入口靠 Node exports 解析展示元数据，
// 因此包**必须**导出 "./package.json" 与 "./locale/*.json" 子路径。
// 这里对「有导出」与「无导出」两类真实包分别解析，证明缺一即静默失去展示信息。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PARENT = pathToFileURL('C:\\Users\\Mutou\\.dsh\\profiles\\web\\').href
const req = createRequire(PARENT + '_')

function tryResolve(spec) {
  try { return { ok: true, path: req.resolve(spec) } }
  catch (e) { return { ok: false, code: e.code } }
}

const packages = [
  'dsh-sekaisync-connect',
  'dsh-zgit',
  'dsh-better-sidebar',
  'whale-girl',
]

console.log('package'.padEnd(24), 'exports ./package.json'.padEnd(24), './locale/*.json')
for (const p of packages) {
  const pj = tryResolve(`${p}/package.json`)
  const loc = tryResolve(`${p}/locale/en.json`)
  let exported = 'n/a'
  if (pj.ok) {
    try {
      const m = JSON.parse(readFileSync(pj.path, 'utf8'))
      exported = JSON.stringify(Object.keys(m.exports ?? {}))
    } catch { exported = '(unreadable)' }
  }
  console.log(
    p.padEnd(24),
    (pj.ok ? 'OK' : 'MISSING ' + pj.code).padEnd(24),
    (loc.ok ? 'OK' : 'MISSING ' + loc.code),
  )
  console.log('  exports keys = ' + exported)
}

console.log('\n--- 结论 ---')
const mine = tryResolve('dsh-sekaisync-connect/package.json')
const myLoc = tryResolve('dsh-sekaisync-connect/locale/en.json')
const ok = mine.ok && myLoc.ok
console.log(ok
  ? 'dsh-sekaisync-connect: 两个子路径都可解析 → 新插件入口能读到 title/description'
  : 'dsh-sekaisync-connect: 元数据不可解析 → Web Plugins 页/Settings 清单将只显示包名')
process.exit(ok ? 0 : 1)
