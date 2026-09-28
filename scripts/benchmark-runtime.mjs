// Synthetic long-prose fixture: no production store is changed or required.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { compactWeb, cut, dispose } from '../lib/backend.js'
import { RequestPool } from '../lib/runtime.js'

function previousCompactWeb(data) {
  const out = []
  for (const r of data.results.slice(0, 12)) {
    const snip = String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    const flags = [r.trust ? `trust=${r.trust}` : '', r.untranslated ? '未翻译' : '', r.language || ''].filter(Boolean).join(' ')
    out.push(`• [${r.kind || '?'}] ${r.id} | ${r.source || ''} | ${flags}\n  ${r.title || ''}\n  ${snip}`)
    const text = String(r.text || '').replace(/\s+/g, ' ').trim()
    if (text) out.push(`  text: ${text.slice(0, 1200)}${text.length > 1200 ? '…' : ''}`)
  }
  return cut(out.join('\n'), 8000)
}

const prose = '星乃一歌 与朋友 走进教室。\n一段很长的剧情正文，包含多语言 words.\t'.repeat(10000).slice(0, 200000)
const fixture = { results: Array.from({ length: 12 }, (_, i) => ({
  id: `story:${i}`, kind: 'event_story', source: 'altsource_sv', trust: 'community',
  language: 'ja', title: '长篇剧情', snippet: ' 摘要  片段\n', text: prose,
})) }
assert.equal(compactWeb(fixture), previousCompactWeb(fixture))

function measure(fn) {
  for (let i = 0; i < 5; i++) fn(fixture)
  const samples = []
  for (let i = 0; i < 60; i++) {
    const start = performance.now()
    fn(fixture)
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return { median_ms: +samples[30].toFixed(3), p95_ms: +samples[57].toFixed(3) }
}
const before = measure(previousCompactWeb)
const after = measure(compactWeb)
const pool = new RequestPool()
let calls = 0
await Promise.all(Array.from({ length: 100 }, () => pool.run('same-web-query', async () => {
  calls++
  await new Promise((resolve) => setTimeout(resolve, 20))
  return true
})))
assert.equal(calls, 1)
console.log(JSON.stringify({
  node: process.version, fixture: { rows: 12, text_chars_per_row: 200000, measured_runs: 60 },
  old_compaction: before, bounded_compaction: after,
  median_speedup: +(before.median_ms / after.median_ms).toFixed(2),
  identical_output: true, concurrent_readers: 100, upstream_operations: calls,
}, null, 2))
dispose()
