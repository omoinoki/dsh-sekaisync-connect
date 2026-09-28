// dsh-sekaisync-connect × DSH V0.1.7-rc.2 + SekaiSync 0.4.0-alpha 实测核查。
// 走插件真实调用路径（lib/backend.js，自管子进程），不裸打 REST。
import {
  call, status, resolveAlias, resolveWithFallback, dispose,
  compactLookup, compactFact, compactResolve, compactTerm, compactPenetrate,
  compactAlias, compactWl, compactWeb, compactNews, compactStatus,
  probeSekai, compactProbe, lexiconStatus, warmupLexicon, sanitizeParams,
} from '../lib/backend.js'

let pass = 0, fail = 0
async function step(name, fn) {
  const t0 = Date.now()
  try {
    const out = await fn()
    const ms = Date.now() - t0
    const text = typeof out === 'string' ? out : JSON.stringify(out)
    console.log(`PASS ${String(ms).padStart(7)}ms  ${name}`)
    if (text) console.log('       ' + text.replace(/\n/g, '\n       ').slice(0, 700))
    pass++
  } catch (e) {
    console.log(`FAIL ${String(Date.now() - t0).padStart(7)}ms  ${name}\n       ${e.message}`)
    fail++
  }
}

console.log('=== 1. 契约与本地逻辑（零 HTTP）===')
await step('lexicon warmup (terms export)', async () => {
  await warmupLexicon()
  const s = lexiconStatus()
  if (s.source !== 'terms_export') throw new Error('lexicon did not load: ' + JSON.stringify(s))
  return `source=${s.source} terms=${s.terms}`
})
await step('probe 跨作品门控 (初音ミク → 非 yes)', () => {
  const p = probeSekai('初音ミク')
  if (p.verdict === 'yes') throw new Error('cross-work name alone must not yield yes: ' + JSON.stringify(p))
  return compactProbe(p)
})
await step('probe 上游指南 §4 用例 (event+location → penetrate)', () => {
  const p = probeSekai('神山高校文化祭在哪办')
  const tags = p.hits.flatMap((h) => h.tags || [])
  if (!tags.includes('event')) throw new Error('expected an event hit: ' + JSON.stringify(p.hits))
  if (!tags.includes('location')) throw new Error('expected a location hit: ' + JSON.stringify(p.hits))
  // 上游指南 §2.3：event 与 location 共现时下一步应走跨语言穿透。
  if (p.hits[0].next_tool !== 'sekai_penetrate') throw new Error('expected next_tool=sekai_penetrate, got ' + p.hits[0].next_tool)
  return compactProbe(p)
})
await step('probe 非世界计划内容 → no', () => {
  const p = probeSekai('帮我写一个快速排序')
  if (p.verdict !== 'no') throw new Error('expected no, got ' + p.verdict)
  return compactProbe(p)
})
await step('sanitizeParams 收敛 P15 边界', () => {
  const s = sanitizeParams('lookup', { query: 'x'.repeat(5000), limit: 999, region: 'jp,zz', language: 'zh_tw' })
  if (s.limit !== 100) throw new Error('limit not clamped: ' + s.limit)
  if (s.query.length !== 2048) throw new Error('query not truncated: ' + s.query.length)
  if (s.region !== 'jp') throw new Error('region not filtered: ' + s.region)
  // 合法语言键原样保留（不改写：改写会抹掉「上游确实没这个语言」的信息）。
  if (s.language !== 'zh_tw') throw new Error('valid language must pass through: ' + s.language)
  // 明显非法的语言键被丢弃，避免把必然 400/无意义的值发出去。
  const bad = sanitizeParams('lookup', { language: 'klingon' })
  if (bad.language !== undefined) throw new Error('invalid language should be dropped: ' + bad.language)
  return JSON.stringify(s).slice(0, 160) + ' | invalid language dropped'
})
await step('resolve 中文变体回退（zh_tw 全未覆盖时按 zh_hant 重试并标注）', async () => {
  const s = sanitizeParams('resolve', { target_language: 'zh_tw' })
  if (s.target_language !== 'zh_tw') throw new Error('language must not be rewritten: ' + s.target_language)
  const d = await resolveWithFallback({ query: 'Ichika', target_language: 'zh_tw' }, { timeoutMs: 110_000 })
  const out = compactResolve(d)
  if (!/重试并命中/.test(out)) throw new Error('expected fallback note: ' + out.slice(0, 200))
  return out.slice(0, 260)
})
await step('取消信号：已中止的 signal 立即结束调用', async () => {
  const ctrl = new AbortController()
  ctrl.abort(new Error('user stop'))
  try {
    await call('lookup', { query: '星乃一歌' }, { timeoutMs: 30_000, signal: ctrl.signal })
    throw new Error('expected cancellation to surface')
  } catch (e) {
    if (!/已取消/.test(e.message)) throw new Error('expected 已取消, got: ' + e.message)
    return e.message
  }
})

console.log('\n=== 2. 端到端（自管子进程，覆盖 0.4.0-alpha 全部消费面）===')
await step('lookup 星乃一歌', async () =>
  compactLookup(await call('lookup', { query: '星乃一歌', limit: 3 }, { timeoutMs: 140_000 })))
await step('fact_pack character:1', async () =>
  compactFact(await call('fact_pack', { entity_id: 'character:1', language: 'en' }, { timeoutMs: 110_000 })))
await step('resolve Ichika (zh_hant)', async () =>
  compactResolve(await call('resolve', { query: 'Ichika', target_language: 'zh_hant' }, { timeoutMs: 110_000 })))
await step('resolve 覆盖声明 (zh_tw → missing 如实标注)', async () => {
  const d = await call('resolve', { query: 'Ichika', target_language: 'zh_tw' }, { timeoutMs: 110_000 })
  const out = compactResolve(d)
  if (!/未覆盖/.test(out)) throw new Error('expected 未覆盖 marker, got: ' + out.slice(0, 200))
  return out.slice(0, 300)
})
await step('term_lookup ネットパラダイス (tags/weight)', async () => {
  const d = await call('term_lookup', { query: 'ネットパラダイス', limit: 2, sort: 'weight' }, { timeoutMs: 110_000 })
  const out = compactTerm(d)
  if (!/tags=product/.test(out)) throw new Error('expected tags=product in output: ' + out.slice(0, 300))
  return out.slice(0, 300)
})
await step('term_lookup tag 过滤 (tag=person 命中 0 属预期)', async () => {
  const d = await call('term_lookup', { query: 'ネットパラダイス', limit: 2, tag: 'person' }, { timeoutMs: 110_000 })
  return `results=${(d.results || []).length} → ${compactTerm(d).slice(0, 120)}`
})
await step('term_penetrate 跨语言穿透（含 missing 如实声明）', async () => {
  const d = await call('term_penetrate', { query: 'ネットパラダイス', languages: 'ja,zh_hans,en' }, { timeoutMs: 190_000 })
  const out = compactPenetrate(d)
  if (!/^ネットパラダイス/m.test(out)) throw new Error('unexpected output: ' + out.slice(0, 200))
  return out.slice(0, 500)
})
await step('resolveAlias khn3 (box)', async () => compactAlias(await resolveAlias('khn3', null, 140_000)))
await step('resolveAlias wl3 (wl round)', async () => compactWl(await resolveAlias('wl3', null, 140_000)))
await step('resolveAlias 官方箱活名', async () => compactAlias(await resolveAlias('雨上がりの一番星', null, 140_000)))
await step('news ja/event（count/matched/正文标记）', async () => {
  const d = await call('news', { limit: 3, language: 'ja', tag: 'event' }, { timeoutMs: 110_000 })
  return compactNews(d).slice(0, 400)
})
await step('news body=false（三态过滤）', async () => {
  const d = await call('news', { limit: 2, body: false }, { timeoutMs: 110_000 })
  if (!d.items.every((i) => i.body_available === false)) throw new Error('body=false filter leaked a body item')
  return compactNews(d).slice(0, 260)
})
await step('web_lookup include_text', async () => {
  const d = await call('web_lookup', { query: 'ネットパラダイス', limit: 1, include_text: true, max_text_chars: 200 }, { timeoutMs: 250_000 })
  const out = compactWeb(d)
  if (!/text: /.test(out)) throw new Error('include_text produced no text section: ' + out.slice(0, 300))
  return out.slice(0, 400)
})
await step('status（freshness + progress + gaps + lexicon）', async () => {
  const { data, meta, progress, gaps } = await status()
  const out = compactStatus(data, meta, progress, gaps)
  if (!/coverage: /.test(out)) throw new Error('expected coverage line: ' + out)
  if (!/lexicon=/.test(out)) throw new Error('expected lexicon line: ' + out)
  return out.slice(0, 600)
})

dispose()
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
