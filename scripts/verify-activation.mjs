// 进程内装配验证：把本插件挂到**本机实际运行的那份 DSH 的 @deepseek-ai/dsh-tools
// 注册表**上，复刻 DSH 的 apply(ctx, config) 路径，验证：
//   - 10 个工具全部通过注册表的 schema 校验并真正进入可见工具表
//   - 每个工具的 output.render 能把返回字符串渲染成 ContentBlock[]
//   - isConcurrencySafe 分类器按预期返回（probe 可并行 / web 独占）
//   - execute 在注册表派发下可被真实调用（用纯本地 sekai_probe，零网络）
//   - 缺参得到插件侧自解释消息（而不是上游 HTTP 400）
//
// ⚠️ 运行时来源很重要：Desktop 版把 dsh 装在 app.asar 内，而 profile 的
// node_modules/@deepseek-ai/* 可能是另一份（源码 checkout 的 junction），
// 版本可能不同。默认优先用 app.asar（真实运行版本），可用 RUNTIME_DIR 覆盖。
//
// 用法：
//   node scripts/verify-activation.mjs                 # 自动定位 app.asar
//   RUNTIME_DIR=<含 @deepseek-ai 的目录> node scripts/verify-activation.mjs
import { existsSync, readdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const HERE = import.meta.dirname

/** 定位 Desktop 的 app.asar（真实运行的那份 dsh）。 */
function findAsar() {
  const candidates = [
    process.env.DSH_ASAR,
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    join(process.env.PROGRAMFILES ?? '', 'DeepSeek Harness', 'resources', 'app.asar'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p))
}

/** 确保有一个含 @deepseek-ai 的运行时目录，返回该目录。 */
async function resolveRuntimeDir() {
  if (process.env.RUNTIME_DIR) return process.env.RUNTIME_DIR
  const asar = findAsar()
  if (!asar) {
    // 退回 profile 的 junction（可能不是当前运行版本，明确告警）
    const fallback = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'node_modules')
    if (existsSync(join(fallback, '@deepseek-ai'))) {
      console.warn('[warn] 未找到 app.asar，退回 profile junction（可能不是当前运行版本）')
      return fallback
    }
    throw new Error('找不到 dsh 运行时：设置 DSH_ASAR 或 RUNTIME_DIR')
  }
  const dest = mkdtempSync(join(tmpdir(), 'dsh-runtime-'))
  // 目标必须是 node_modules 目录：Node 的包解析要求 scope 目录位于 node_modules 之下。
  execFileSync(process.execPath, [join(HERE, 'extract-asar-runtime.mjs'), asar, join(dest, 'node_modules')], { stdio: 'inherit' })
  return join(dest, 'node_modules')
}

const runtimeRoot = await resolveRuntimeDir()
const toolsMod = await import(pathToFileURL(join(runtimeRoot, '@deepseek-ai/dsh-tools/lib/index.js')).href)
const cordis = await import(pathToFileURL(join(runtimeRoot, '@deepseek-ai/cordis/lib/index.js')).href)
const plugin = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

// 报告被测运行时的真实版本，避免"测错版本"再次发生
const runtimePkg = JSON.parse(
  (await import('node:fs')).readFileSync(join(runtimeRoot, '@deepseek-ai/dsh-tools/package.json'), 'utf8'))
console.log(`runtime: @deepseek-ai/dsh-tools ${runtimePkg.version} @ ${runtimeRoot}`)

const ctx = new cordis.Context()
class StubSystemPrompt extends cordis.Service {
  constructor(c) { super(c, 'systemPrompt') }
  section() { return () => {} }
  tools() { return () => {} }
}
ctx.plugin(StubSystemPrompt)
await new Promise((r) => setTimeout(r, 50))

ctx.plugin(toolsMod.ToolRuntime)
await new Promise((r) => setTimeout(r, 200))
const tools = ctx.get('tools')
if (!tools) { console.log('FAIL: tool registry did not mount'); process.exit(2) }

const row = { store: 'C:\\dsh_projects\\sekaisync-handoff-2026-08-14\\store' }
ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, row)
await new Promise((r) => setTimeout(r, 250))

const sekai = tools.schemas().filter((s) => s.name.startsWith('sekai_'))
console.log(`visible sekai_* tools: ${sekai.length}/10`)
for (const s of sekai) {
  console.log('  ' + s.name.padEnd(18)
    + 'props=' + String(Object.keys(s.parameters?.properties || {}).length).padEnd(3)
    + ' req=' + JSON.stringify(s.parameters?.required || []))
}

let bad = 0
for (const s of sekai) {
  const blocks = tools.get(s.name).output.render({}, 'hello')
  if (!(Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text === 'hello')) {
    bad++; console.log('  RENDER BAD: ' + s.name)
  }
}
console.log(`render() contracts: ${sekai.length - bad}/${sekai.length} OK`)

const probeSafe = tools.get('sekai_probe').isConcurrencySafe?.({})
const webSafe = tools.get('sekai_web').isConcurrencySafe?.({})
console.log(`isConcurrencySafe: sekai_probe=${probeSafe} sekai_web=${webSafe}`)

const { loadConfig } = await import(pathToFileURL(join(HERE, '..', 'lib', 'backend.js')).href)
const cfg = loadConfig()
console.log('config from row applied: store=' + cfg.store)
const cfgOk = cfg.store === row.store

let dispatchOk = false
try {
  const res = await tools.execute({
    name: 'sekai_probe', arguments: { query: 'ネットパラダイス' },
    callId: 't1', rootCallId: 't1', signal: new AbortController().signal,
  })
  const text = String(res?.value ?? res?.content?.[0]?.text ?? '')
  dispatchOk = res?.isError !== true && /probe/.test(text)
  console.log('dispatch sekai_probe -> ' + text.replace(/\n/g, ' | ').slice(0, 160))
} catch (e) { console.log('dispatch FAILED: ' + String(e.message).slice(0, 160)) }

// 本插件的契约是「execute 永远返回字符串」，缺参因此体现为 content 文本而非 isError。
let argGuardOk = false
try {
  const res = await tools.execute({
    name: 'sekai_lookup', arguments: {}, callId: 't2', rootCallId: 't2',
    signal: new AbortController().signal,
  })
  const text = String(res?.value ?? res?.content?.[0]?.text ?? '')
  argGuardOk = /缺少必填参数 query/.test(text) && !/HTTP 400/.test(text)
  console.log('missing-required arg -> ' + text.slice(0, 140))
} catch (e) { console.log('arg guard FAILED: ' + String(e.message).slice(0, 160)) }

const ok = sekai.length === 10 && bad === 0 && cfgOk
  && probeSafe === true && webSafe === false && dispatchOk && argGuardOk
console.log(ok
  ? `\nACTIVATION OK on dsh-tools ${runtimePkg.version} (schemas+render+config+concurrency+dispatch+argguards)`
  : '\nACTIVATION PROBLEM')
process.exit(ok ? 0 : 1)
