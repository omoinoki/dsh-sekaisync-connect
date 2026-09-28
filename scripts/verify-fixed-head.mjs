// 独立验证：针对修复后的 sekaisync HEAD（d4cf781 及之后）。
// 用真机 store 起一个服务器，逐项复现我上一轮报告的失败点，并跑插件全链路。
//
// 关注点：
//   1. /health 是否 O(1)（修复前 21–40s）→ 决定插件的 1.2/1.5s 探测能否命中
//   2. lookup / freshness / fact_pack 是否从 ~25s 降到秒级
//   3. 探测风暴后服务器是否仍可用（修复前会被打成不可用且不自愈）
//   4. 插件 12 项全链路（backend.js 真实路径）
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const ROOT = 'C:\\dsh_projects\\sekaisync-handoff-2026-08-14'
const STORE = ROOT + '\\store'
const PORT = 8790
const BASE = `http://127.0.0.1:${PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function timed(label, url, budgetMs) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), budgetMs)
  const s = Date.now()
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    const body = await r.text()
    return { label, ms: Date.now() - s, status: r.status, len: body.length, body }
  } catch (e) {
    return { label, ms: Date.now() - s, status: null, err: e.name, body: '' }
  } finally { clearTimeout(t) }
}

const show = (r) => {
  const tag = r.status === 200 ? 'OK  ' : 'FAIL'
  console.log(`  ${tag} ${r.label.padEnd(34)} ${String(r.ms).padStart(7)}ms  ${r.status ?? r.err}`)
}

console.log('=== 启动修复后的服务器 ===')
const child = spawn('python', ['-u', '-m', 'sekaisync', '--no-event-check', '--store', STORE,
  'serve-http', '--host', '127.0.0.1', '--port', String(PORT)],
{ cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => { out += d.toString() })
child.stderr.on('data', (d) => { out += d.toString() })
child.on('error', (e) => console.log('spawn error:', e.message))

console.log('\n=== 1) /health 冷启成本（修复前 21–40s；插件探测预算 1.2/1.5s）===')
const hs = Date.now()
let ready = false
while (Date.now() - hs < 240_000) {
  if (child.exitCode !== null) { console.log('  server exited:', child.exitCode); break }
  const r = await timed('health probe (1500ms budget)', BASE + '/health', 1500)
  if (r.status === 200 && r.body.includes('"ready": true')) { ready = true; console.log(`  READY within 1500ms budget after ${Date.now() - hs}ms -> ${r.body}`); break }
  await sleep(300)
}
if (!ready) console.log('  NOT ready within 1500ms probes (would still break the plugin probe)')

console.log('\n=== 2) 端点成本（修复前 lookup ~25s / freshness ~21s / fact_pack ~21s）===')
for (const [label, url] of [
  ['/health', BASE + '/health'],
  ['/openapi.json', BASE + '/openapi.json'],
  ['/api/v1/freshness', BASE + '/api/v1/freshness'],
  ['/api/v1/lookup (cold)', BASE + '/api/v1/lookup?query=Ichika&limit=3'],
  ['/api/v1/lookup (warm)', BASE + '/api/v1/lookup?query=Ichika&limit=3'],
  ['/api/v1/fact_pack', BASE + '/api/v1/fact_pack?entity_id=character%3A1&language=en'],
  ['/api/v1/activity khn3', BASE + '/api/v1/activity?query=khn3'],
]) show(await timed(label, url, 120_000))

console.log('\n=== 3) 探测风暴后服务器是否仍可用（修复前：lookup 从 20.7s 退化成 90s 超时且不自愈）===')
let aborted = 0
const stormEnd = Date.now() + 20_000
while (Date.now() < stormEnd) {
  const r = await timed('storm', BASE + '/health', 1500)
  if (r.status !== 200) aborted++
  await sleep(300)
}
console.log(`  发出 ${aborted} 次被中止的探测`)
show(await timed('lookup after storm', BASE + '/api/v1/lookup?query=Ichiro&limit=3', 120_000))
show(await timed('lookup after storm #2', BASE + '/api/v1/lookup?query=星乃一歌&limit=3', 120_000))

console.log('\n=== 4) 关掉自建服务器，把 8787 让给插件真实路径 ===')
child.kill()
await sleep(2000)

console.log('\n=== server 输出（尾部）===')
console.log(out.split('\n').slice(-6).join('\n'))
console.log(`\nstore 存在: ${existsSync(STORE)}`)
