// 验证修复后的上游是否让「原始探测预算」重新可用 —— 即我上一轮对
// backend.js 的探测改动，究竟是仍然必要，还是已被上游修复取代。
//
// 上游修复前：/health 21–40s，1.2/1.5s 探测必然失败 -> 风暴 -> 服务器被打满。
// 上游修复后：/health 应为 O(1)（毫秒级），1.2/1.5s 应能命中。
import { spawn } from 'node:child_process'

const ROOT = 'C:\\dsh_projects\\sekaisync-handoff-2026-08-14'
const STORE = ROOT + '\\store'
const PORT = 8793
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 插件 probeHealth 的原始实现（修复前的预算）
async function probeHealth(url, timeoutMs) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return false
    const j = await res.json()
    return !!(j && j.status === 'ok' && j.ready === true)
  } catch { return false } finally { clearTimeout(t) }
}

const child = spawn('python', ['-u', '-m', 'sekaisync', '--no-event-check', '--store', STORE,
  'serve-http', '--host', '127.0.0.1', '--port', String(PORT)],
{ cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
child.on('error', (e) => console.log('spawn error:', e.message))

// 等横幅出现（spawnServer 的真实就绪信号）
await new Promise((res) => {
  let buf = ''
  child.stdout.on('data', (d) => { buf += d.toString(); if (buf.includes('listening on')) res() })
  setTimeout(res, 120_000)
})

console.log('=== A) 原始预算 1500ms 的就绪探测（修复前必然失败）===')
let ok = 0, tries = 0
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  tries++
  if (await probeHealth(`${BASE}/health`, 1500)) { ok++; break }
  await sleep(500)
}
console.log(`  原始就绪循环：${tries} 次探测，成功 ${ok} 次 -> ${ok > 0 ? '可确认就绪（风暴不会发生）' : '仍失败'}`)

console.log('\n=== B) 原始外部端口探测预算 1200ms（config externalPort 复用路径）===')
const extOk = await probeHealth(`${BASE}/health`, 1200)
console.log(`  1200ms 探测 -> ${extOk ? '命中（外部端口复用恢复）' : '失败（仍需要放宽预算）'}`)

console.log('\n=== C) 复现风暴：20s 内密集 1500ms 探测，随后看服务器是否还健康 ===')
let aborted = 0, succeeded = 0
const stormEnd = Date.now() + 20_000
while (Date.now() < stormEnd) {
  if (await probeHealth(`${BASE}/health`, 1500)) succeeded++; else aborted++
  await sleep(300)
}
console.log(`  探测 ${aborted + succeeded} 次：成功 ${succeeded}，失败 ${aborted}`)
for (const [label, url] of [
  ['lookup after storm', `${BASE}/api/v1/lookup?query=Ichika&limit=3`],
  ['freshness after storm', `${BASE}/api/v1/freshness`],
]) {
  const s = Date.now()
  try {
    const r = await fetch(url); await r.text()
    console.log(`  OK   ${label.padEnd(24)} ${Date.now() - s}ms http=${r.status}`)
  } catch (e) { console.log(`  FAIL ${label.padEnd(24)} ${Date.now() - s}ms ${e.name}`) }
}
console.log(`\n修复前对照：同样风暴后 lookup 90016ms AbortError，且 40s 后仍未恢复。`)

child.kill()
