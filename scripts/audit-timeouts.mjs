// 审计：每个工具的「外层 DSH timeoutMs」是否严格大于「内层 fetch abort 预算」。
// 若两者相等（或外层更小），DSH 的 dsh-tool-call-timeout-policy 会抢在插件自己的
// 诊断消息之前掐断调用，模型就拿不到「ERROR: xxx 超时」这类可执行提示。
//
// DSH V0.1.7-rc.2 起 `timeoutMs` 在 ToolDefinition 上只是「声明」：真正执行截止
// 时间的是 @deepseek-ai/dsh-tool-call-timeout-policy 的 tools/execute 包装层，
// 它按 ctx.tools.get(name)?.timeoutMs 读取本表的外层值。故该断言仍然成立且必要。
import * as idx from '../lib/index.js'

const TOOLS = []
idx.apply({
  tools: { register: (d) => { TOOLS.push(d); return () => {} } },
  effect: (fn) => { fn(); return () => {} },
  inject: () => () => {},
  // apply 会在 loader/volatile-update 上挂监听器（volatile-only 改动不重启插件行）。
  on: () => () => {},
})

// 内层预算来自 index.js 导出的 BUDGETS（不再用正则解析源码），
// 键 → 工具名的映射在此显式声明，改工具名时这里会直接报错而不是静默跳过。
const INNER = {
  sekai_lookup: idx.BUDGETS.lookup.inner,
  sekai_fact: idx.BUDGETS.fact.inner,
  sekai_resolve: idx.BUDGETS.resolve.inner,
  sekai_term: idx.BUDGETS.term.inner,
  sekai_penetrate: idx.BUDGETS.penetrate.inner,
  sekai_alias: idx.BUDGETS.alias.inner,
  sekai_web: idx.BUDGETS.web.inner,
  sekai_news: idx.BUDGETS.news.inner,
  sekai_status: idx.BUDGETS.status.inner,
}

let bad = 0
// 纯本地工具：execute 不发 HTTP，故没有内层预算可比（不是缺配置）。
const PURE_LOCAL = new Set(['sekai_probe'])
console.log('tool'.padEnd(17), 'outer'.padStart(8), 'inner'.padStart(8), 'margin'.padStart(8), '  verdict')
for (const d of TOOLS) {
  const outer = d.timeoutMs
  if (PURE_LOCAL.has(d.name)) {
    console.log(d.name.padEnd(17), String(outer).padStart(8), 'n/a'.padStart(8), 'n/a'.padStart(8), '  pure-local (no HTTP)')
    continue
  }
  const inner = INNER[d.name]
  if (inner === undefined) { bad++; console.log(d.name.padEnd(17), String(outer).padStart(8), '?'.padStart(8), '?'.padStart(8), '  CHECK: no inner budget mapped'); continue }
  const margin = outer - inner
  const ok = margin > 0
  if (!ok) bad++
  console.log(d.name.padEnd(17), String(outer).padStart(8), String(inner).padStart(8), String(margin).padStart(8), ok ? '  OK' : '  CHECK')
}
// 反向断言：BUDGETS 里不应存在没有对应工具的孤儿条目（防止改了工具名留下死预算）。
const names = new Set(TOOLS.map((t) => t.name))
for (const [tool, inner] of Object.entries(INNER)) {
  if (!names.has(tool)) { bad++; console.log(`CHECK: inner budget mapped for unknown tool ${tool} (${inner})`) }
}
console.log(bad === 0 ? `\nall ${TOOLS.length} tools: outer budget > inner abort budget` : `\n${bad} tool(s) need attention`)
process.exit(bad === 0 ? 0 : 1)
