// 在 app.asar 内按正则检索文本文件（无需解包整个 asar）。
// 用途：核实某 API/槽位/字符串在**本机实际运行的那份 DSH** 中是否存在及其用法。
//
// asar 容器布局（Pickle）：
//   u32(0)=4 · u32(4)=header 载荷长 · u32(8)=JSON 长+4 · u32(12)=JSON 长
//   目录 JSON 位于 [16, 16+u32(12))
//   数据段起点 = align4(8 + u32(4))   ← 注意不是 16+u32(12)（会少 2 字节）
//
// 用法：
//   node scripts/grep-asar.mjs <正则> [asar路径] [限定路径子串] [最大命中数]
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const pattern = process.argv[2]
if (!pattern) {
  console.error('usage: node grep-asar.mjs <regex> [asarPath] [pathFilter] [maxHits]')
  process.exit(2)
}
const asarPath = process.argv[3] || join(
  process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
const pathFilter = process.argv[4] || ''
const maxHits = Number(process.argv[5] ?? 40)
if (!existsSync(asarPath)) { console.error('asar not found: ' + asarPath); process.exit(2) }

const fd = readFileSync(asarPath)
const jsonSize = fd.readUInt32LE(12)
const dataStart = (8 + fd.readUInt32LE(4) + 3) & ~3
const header = JSON.parse(fd.subarray(16, 16 + jsonSize).toString('utf8'))

function walk(node, p, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const child = p ? `${p}/${name}` : name
    if (entry.files) walk(entry, child, out)
    else out.push({ path: child, offset: Number(entry.offset ?? 0), size: entry.size ?? 0 })
  }
}
const files = []
walk(header, '', files)

const re = new RegExp(pattern)
let hits = 0
for (const f of files) {
  if (hits >= maxHits) break
  if (pathFilter && !f.path.includes(pathFilter)) continue
  if (!/\.(js|mjs|cjs|json|md|ts|yml|yaml)$/.test(f.path)) continue
  if (f.size > 6_000_000) continue
  const text = fd.subarray(dataStart + f.offset, dataStart + f.offset + f.size).toString('utf8')
  if (!re.test(text)) continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && hits < maxHits; i++) {
    if (re.test(lines[i])) {
      console.log(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 220)}`)
      hits++
    }
  }
}
console.error(`[grep-asar] ${hits} hit(s)${hits >= maxHits ? ' (truncated)' : ''}`)
