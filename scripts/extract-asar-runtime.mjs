// 从 app.asar 抽取 dsh 的 Node 运行时（@deepseek-ai/* 等），供验证脚本对着
// **本机实际运行的那份 DSH** 运行。
//
// 为什么需要它：Desktop 版把 dsh 代码装在 resources/app.asar 里，
// 而 profile 的 node_modules/@deepseek-ai/* 可能是**另一份**（例如某个源码
// checkout 的 junction）。两者版本可能不同，用错那份会让验证结论失真。
//
// asar 容器布局（Pickle）：
//   u32(0) = 4
//   u32(4) = header pickle 载荷长度
//   u32(8) = JSON 长度 + 4
//   u32(12)= JSON 长度
//   随后 16..16+json 是目录 JSON，数据段起点 = align4(8 + u32(4))。
//
// ⚠️ 常见错误：用 `16 + u32(12)` 当数据起点会**少 2 字节**，
// 于是每个抽取出的文件头部多 2 个垃圾字符、尾部少 2 字节。
// 文本文件仍"看起来能读"，但字节级判断与文件末尾内容都会失真。
//
// 用法：
//   node scripts/extract-asar-runtime.mjs [asar路径] [目标目录] [asar内前缀]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const asarPath = process.argv[2]
const destRoot = process.argv[3]
const prefix = process.argv[4] ?? 'dsh/node_modules'
if (!asarPath || !destRoot) {
  console.error('usage: node extract-asar-runtime.mjs <app.asar> <destDir> [prefix]')
  process.exit(2)
}

const fd = readFileSync(asarPath)
const jsonSize = fd.readUInt32LE(12)
const dataStart = (8 + fd.readUInt32LE(4) + 3) & ~3
const header = JSON.parse(fd.subarray(16, 16 + jsonSize).toString('utf8'))

// 自检：数据段起点必须让已知 JSON 文件解析成功，否则偏移算错。
function walk(node, p, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const child = p ? p + '/' + name : name
    if (entry.files) walk(entry, child, out)
    else out.push({ path: child, offset: Number(entry.offset ?? 0), size: entry.size ?? 0 })
  }
}
const files = []
walk(header, '', files)

const probe = files.find((f) => f.path === `${prefix}/@deepseek-ai/dsh-tools/package.json`)
if (probe) {
  const probeBuf = fd.subarray(dataStart + probe.offset, dataStart + probe.offset + probe.size)
  try { JSON.parse(probeBuf.toString('utf8')) } catch (e) {
    console.error(`asar 数据段偏移校验失败（dataStart=${dataStart}）：${e.message}`)
    process.exit(3)
  }
}

const chosen = files.filter((f) => f.path.startsWith(prefix + '/'))
let written = 0
for (const f of chosen) {
  const rel = f.path.slice(prefix.length + 1)
  if (!rel) continue
  const dest = join(destRoot, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, fd.subarray(dataStart + f.offset, dataStart + f.offset + f.size))
  written++
}
console.log(`extracted ${written} files from ${prefix} -> ${destRoot}`)
