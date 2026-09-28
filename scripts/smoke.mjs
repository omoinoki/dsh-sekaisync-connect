// 冒烟测试：不依赖 cordis，直接验证 backend 全链路（真实拉起 sekaisync 子进程）。
// 覆盖 SekaiSync 0.4.0-alpha 的消费面：动态热词表、实体/事实/译名/用语、
// 跨语言穿透、活动解析（box + WL + 官方箱活名）、剧情全文、官方公告、状态。
import {
  loadConfig, resolveStore, call, status, dispose, resolveAlias, resolveWithFallback,
  compactLookup, compactFact, compactResolve, compactTerm, compactPenetrate,
  compactAlias, compactWl, compactWeb, compactStatus, compactNews,
  probeSekai, compactProbe, warmupLexicon, lexiconStatus,
} from '../lib/backend.js'

const t0 = Date.now()
const cfg = loadConfig()
console.log(`[config] python=${cfg.python} store=${cfg.store} externalPort=${cfg.externalPort}`)
console.log(`[store] ${resolveStore(cfg)}`)

// 动态热词表（0.4.0-alpha：由 store 构建，不再是手写静态数组）
await warmupLexicon()
console.log(`[lexicon] ${JSON.stringify(lexiconStatus())}`)
console.log(`[probe] ${compactProbe(probeSekai('ネットパラダイス'))}`)

const cases = [
  ['lookup', compactLookup, { query: '星乃一歌', limit: 3 }, 140_000],
  ['fact_pack', compactFact, { entity_id: 'character:1', language: 'en' }, 110_000],
  ['term_lookup', compactTerm, { query: 'ネットパラダイス', limit: 2, sort: 'weight' }, 110_000],
  ['term_penetrate', compactPenetrate, { query: 'ネットパラダイス', languages: 'ja,zh_hans,en' }, 190_000],
  ['activity(khn3)', compactAlias, { query: 'khn3' }, 140_000],
  ['activity(wl3)', compactWl, { query: 'wl3' }, 140_000],
  ['news', compactNews, { limit: 5, language: 'ja', tag: 'event' }, 110_000],
  ['web_lookup', compactWeb, { query: 'ネットパラダイス', language: 'ja', limit: 2 }, 250_000],
]
for (const [label, compactor, params, timeoutMs] of cases) {
  const method = label.startsWith('activity') ? 'activity' : label
  const s = Date.now()
  try {
    const data = await call(method, params, { timeoutMs })
    const out = compactor(data)
    console.log(`\n===== ${label} (${Date.now() - s}ms, ${out.length} chars) =====\n${out}`)
  } catch (e) {
    console.log(`\n===== ${label} FAIL =====\n${e.message}`)
  }
}

try {
  const d = await resolveWithFallback({ query: 'Ichika', target_language: 'zh_hant' }, { timeoutMs: 110_000 })
  console.log(`\n===== resolve =====\n${compactResolve(d)}`)
} catch (e) { console.log(`\n===== resolve FAIL =====\n${e.message}`) }

try {
  const out = compactAlias(await resolveAlias('雨上がりの一番星', null, 140_000))
  console.log(`\n===== resolveAlias(官方箱活名) =====\n${out}`)
} catch (e) { console.log(`\n===== resolveAlias FAIL =====\n${e.message}`) }

try {
  const { data, meta, progress, gaps } = await status()
  console.log(`\n===== status (${Date.now() - t0}ms) =====\n${compactStatus(data, meta, progress, gaps)}`)
} catch (e) {
  console.log(`\n===== status FAIL =====\n${e.message}`)
}

dispose()
console.log('\n[done]')
