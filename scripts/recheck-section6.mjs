// 独立复核 §六 表格里「修复后」的数字是否复现（不采信报告，直接实测）。
// 同一 store、同一修复后 HEAD。
import { spawn } from 'node:child_process'

const ROOT = 'C:\\dsh_projects\\sekaisync-handoff-2026-08-14'
const STORE = ROOT + '\\store'
const PORT = 8794
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function timed(url, ms = 300_000) {
  const c = new AbortController(); const h = setTimeout(() => c.abort(), ms)
  const s = Date.now()
  try { const r = await fetch(url, { signal: c.signal }); const b = await r.text(); return { ms: Date.now() - s, st: r.status, len: b.length } }
  catch (e) { return { ms: Date.now() - s, st: e.name } } finally { clearTimeout(h) }
}

const child = spawn('python', ['-u', '-m', 'sekaisync', '--no-event-check', '--store', STORE,
  'serve-http', '--host', '127.0.0.1', '--port', String(PORT)],
{ cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
child.on('error', (e) => console.log('spawn error:', e.message))
await new Promise((res) => {
  let b = ''
  child.stdout.on('data', (d) => { b += d.toString(); if (b.includes('listening on')) res() })
  setTimeout(res, 120_000)
})
await sleep(1000)

console.log('端点                             本次实测      报告§六声称')
const cases = [
  ['/health (ready)', '/health', '1.6–2.7ms'],
  ['freshness', '/api/v1/freshness', '0.01s'],
  ['fact_pack character:1', '/api/v1/fact_pack?entity_id=character%3A1&language=en', '<20ms'],
  ['lookup (cold #1)', '/api/v1/lookup?query=' + encodeURIComponent('星乃一歌') + '&limit=8', '9.3s cold'],
  ['lookup (warm #2)', '/api/v1/lookup?query=' + encodeURIComponent('星乃一歌') + '&limit=8', '3.0s'],
  ['term_lookup', '/api/v1/term_lookup?query=' + encodeURIComponent('ネットパラダイス') + '&limit=8', '0.21s'],
  ['resolve', '/api/v1/resolve?query=Ichika&target_language=zh_hant', '1.4s'],
  ['news', '/api/v1/news?limit=20', '0.11s'],
  ['activity khn3', '/api/v1/activity?query=khn3', 'n/a'],
  ['trust', '/api/v1/trust', '<10ms warm'],
  ['status', '/api/v1/status', '20.1s first'],
  ['web_lookup', '/api/v1/web_lookup?query=' + encodeURIComponent('ネットパラダイス') + '&limit=5', '~137s'],
]
for (const [label, path, claim] of cases) {
  const r = await timed(BASE + path, 300_000)
  console.log(`${label.padEnd(32)} ${String(r.ms + 'ms').padStart(10)}  ${r.st}   ← ${claim}`)
}
child.kill()
