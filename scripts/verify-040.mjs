// 0.4.0-alpha 实测脚本：走插件真实后端路径（backend.js 全链路），
// 复用 config.json 的 externalPort 上已就绪的服务器，避免 spawn 子进程
// （在受限沙箱下 spawn+piped stdio 会被拒），从而能验证 内层 fetch 预算、
// 压缩器、TTL 缓存与 resolveAlias 是否对 0.4.0-alpha 生效。
import {
  call, status, dispose, resolveAlias, looksLikeAliasQuery,
  compactLookup, compactFact, compactResolve, compactTerm,
  compactAlias, compactWl, compactStatus, compactNews, compactWeb,
  probeSekai, compactProbe,
} from '../lib/backend.js'

const comp = (data) => (data && data.kind === 'wl' ? compactWl(data) : compactAlias(data))
const t0 = Date.now()
const rows = []
let fails = 0

async function step(label, fn) {
  const s = Date.now()
  try {
    const out = await fn()
    const ms = Date.now() - s
    rows.push({ label, ms, ok: true, out: String(out) })
    console.log(`\n===== ${label}  ${ms}ms  (${String(out).length} chars) =====\n${out}`)
  } catch (e) {
    fails++
    const ms = Date.now() - s
    rows.push({ label, ms, ok: false, out: e.message })
    console.log(`\n===== ${label}  FAIL ${ms}ms =====\n${e.message}`)
  }
}

console.log('[phase] status (also proves the server is reused, not spawned)')
await step('status', async () => { const { data, meta } = await status(); return compactStatus(data, meta) })

// 内层 fetch 预算：新代码为 90_000（旧代码 30_000 会在此失败）
await step('lookup 星乃一歌 (inner budget 90s)', async () =>
  compactLookup(await call('lookup', { query: '星乃一歌', limit: 3 }, { timeoutMs: 90_000 })))
await step('fact_pack character:1 (inner 60s)', async () =>
  compactFact(await call('fact_pack', { entity_id: 'character:1', language: 'en' }, { timeoutMs: 60_000 })))
await step('resolve Ichika', async () =>
  compactResolve(await call('resolve', { query: 'Ichika', target_language: 'zh_hant' }, { timeoutMs: 30_000 })))
await step('term_lookup ネットパラダイス', async () =>
  compactTerm(await call('term_lookup', { query: 'ネットパラダイス', limit: 3 }, { timeoutMs: 30_000 })))
await step('news ja/event', async () =>
  compactNews(await call('news', { limit: 5, language: 'ja', tag: 'event' }, { timeoutMs: 30_000 })))

// resolveAlias：统一端点 /activity，box 与 wl 两条分支
await step('resolveAlias khn3 (box)', async () => comp(await resolveAlias('khn3', undefined, 60_000)))
await step('resolveAlias wl3 (wl)', async () => comp(await resolveAlias('wl3', undefined, 60_000)))
await step('resolveAlias 官方箱活名', async () =>
  comp(await resolveAlias('雨过天晴的启明星', undefined, 60_000)))
await step('looksLikeAliasQuery', async () => String(looksLikeAliasQuery('心羽3')))

await step('probe', async () => compactProbe(probeSekai('初音ミク')))

// web_lookup 很慢，放最后
await step('web_lookup (inner 240s)', async () =>
  compactWeb(await call('web_lookup', { query: 'ネットパラダイス', language: 'ja', limit: 2 }, { timeoutMs: 240_000 })))

console.log('\n================ 汇总 ================')
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${String(r.ms).padStart(7)}ms  ${r.label}`)
console.log(`\ntotal ${Date.now() - t0}ms, failures=${fails}`)
dispose()
