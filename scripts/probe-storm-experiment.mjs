// 受控实验：插件启动就绪探测（probeHealth 1500ms abort + 500ms sleep，最长 30s）
// 是否会把 0.4.0-alpha 的服务器打到信号量饱和，从而拖垮随后的真实调用。
// 对照组：纯净服务器上直接发真实请求。
const BASE = process.argv[2]
const real = async (label, ms) => {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  const s = Date.now()
  try {
    const r = await fetch(`${BASE}/api/v1/lookup?query=Ichika&limit=3`, { signal: ctrl.signal })
    const body = await r.text()
    console.log(`  ${label}: ${Date.now() - s}ms http=${r.status} len=${body.length}`)
  } catch (e) {
    console.log(`  ${label}: ${Date.now() - s}ms FAIL ${e.name} ${e.message}`)
  } finally { clearTimeout(t) }
}

console.log('[control] clean server, one real lookup (90s budget)')
await real('control', 90_000)

console.log('\n[storm] replaying the plugin readiness loop exactly: probe 1500ms + sleep 500ms, 30s')
let aborted = 0, ok = 0
const t0 = Date.now()
while (Date.now() - t0 < 30_000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 1_500)
  try {
    const r = await fetch(`${BASE}/health`, { signal: ctrl.signal })
    if (r.status === 200) ok++
  } catch { aborted++ } finally { clearTimeout(t) }
  await new Promise(r => setTimeout(r, 500))
}
console.log(`  storm done: aborted=${aborted} ok=${ok}`)

console.log('\n[treatment] same real lookup immediately after the storm')
await real('treatment', 90_000)
console.log('\n[settle] wait 40s then retry, to distinguish backlog from permanent wedge')
await new Promise(r => setTimeout(r, 40_000))
await real('after-40s', 90_000)
