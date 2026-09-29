// dsh-sekaisync-connect 后端：管理 sekaisync HTTP 子进程 + 结果压缩（token 最小化）。
// 零依赖：仅 node: 内置模块 + 全局 fetch。纯 ESM。
//
// 3.x 对齐目标：
//   - DeepSeek Harness V0.1.7-rc.2：协作式取消（exec.signal 真正中止 fetch）、
//     isConcurrencySafe 并行分类、P15 边界前置校验（避免把 400 丢给模型）。
//   - SekaiSync 0.4.0-alpha：schema v3 / 逐区服事实 / 逐语言槽 /
//     不可变代际发布；新增 term_penetrate、term_lookup tag+sort、
//     web_lookup include_text、news body 过滤；热词表由静态数组改为
//     「启动时从 store 构建的动态词表」（上游 docs/DSH_PLUGIN_GUIDE.md §2.1）。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ByteLru, RequestPool, deadlineSignal, waitWithSignal, readBoundedText, runCommand, compactExcerpt } from './runtime.js'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const START_TIMEOUT_MS = 120_000 // 首启含 registry 构建与 SQLite 迁移，慢盘留足余量
const DEFAULT_REGIONS = 'jp,en,tc,kr,cn'

// ── 上游 P15 参数预算（sekaisync/tools.py）──────────────────────────────
// 超限一律 400。插件在发出前先收敛，把「参数越界」变成一次成功调用，
// 而不是让模型收到一条 HTTP 400 后再自己猜边界。
const MAX_LIMIT = 100
const MAX_QUERY_LENGTH = 2048
const MAX_TEXT_CHARS = 200_000
const REGION_KEYS = new Set(['jp', 'en', 'tc', 'kr', 'cn'])
// 上游各端点对「中文变体」的命名并不统一：tools.py 的 LANGUAGES_MCP /
// CSV_LANG_DEFAULT 用 zh_tw，而 v3 store 的实体 names_json 与译名槽用 zh_hant。
// 实测 `/resolve?target_language=zh_tw`（正是上游自己的默认值）返回
// translation_status=missing，而 zh_hant 返回 available。
// 处理方式：**不静默改写**调用方给的语言，而是先如实查询；仅当整个结果集
// 都是「未覆盖」时才用变体重试一次，并回报实际命中的语言（见 resolveWithFallback）。
const LANGUAGE_VARIANTS = {
  'zh_tw': 'zh_hant', 'zh-tw': 'zh_hant', 'zh_hant': 'zh_tw', 'zh_hant_tw': 'zh_tw',
  'zh_cn': 'zh_hans', 'zh-cn': 'zh_hans', 'zh_hans': 'zh_cn',
}
const KNOWN_LANGUAGES = new Set(['ja', 'en', 'zh_hans', 'zh_hant', 'zh_tw', 'zh_cn', 'ko'])

// ── 配置：env > profile 行 config > SEKAISYNC_CONFIG 文件 > config.local.json > 插件目录 config.json > 自动发现 ──
// 配置分层（从低到高）：插件目录 config.json < config.local.json < SEKAISYNC_CONFIG
// < profile 行的 Cordis Config（apply(ctx, config)）< 环境变量 < 面板刚保存的乐观覆盖层。
// Config schema 见 lib/config.js；store/root 声明为 .volatile()，因此 profile 行里的
// 改动由 Settings 服务写进 cordis.patch.yml，升级不覆盖、写后热加载。
// 这里保存的是 apply() 收到的**原始 config 对象**而非快照——见下方 runtimeConfig 的说明。
let resolvedStoreCache = null
let discoveringStore = null

function storeConfigKey(cfg) { return JSON.stringify([cfg.store, cfg.root, cfg.python, process.cwd()]) }
function rememberStore(cfg, store) {
  resolvedStoreCache = { key: storeConfigKey(cfg), store }
  return store
}
function cachedStore(cfg) {
  return resolvedStoreCache?.key === storeConfigKey(cfg) && existsSync(join(resolvedStoreCache.store, 'kb'))
    ? resolvedStoreCache.store : null
}

/**
 * 解包 Volatile 引用：声明了 Cordis Config 且字段带 .volatile() 时，
 * apply(ctx, config) 收到的 store/root 是「Volatile 引用」（暴露 .get() 的对象），
 * 而不是普通字符串。这里把整个 config 拍平成普通值快照。
 */
function unwrapConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config
  const out = {}
  for (const [key, value] of Object.entries(config)) {
    out[key] = (value && typeof value === 'object' && !Array.isArray(value) && typeof value.get === 'function')
      ? value.get()
      : value
  }
  return out
}

/**
 * apply() 收到的**原始** config 对象。
 *
 * 必须保留原对象而不是它的快照：Volatile 引用是「同一个对象、内部值就地更新」
 * （cosmokit 的 createVolatile：Object.freeze({ get, [write] })）。当面板调用
 * settings.update 时，loader 走 volatileOnly 分支——**不会重新 apply**，
 * 而是把新值写进这些既有的引用里，再向所属 fiber 发 `loader/volatile-update`。
 * 因此每次读取都要重新 .get()，否则永远读到 apply 那一刻的旧值。
 */
let runtimeConfig = null

/** 由 apply() 注入 profile 行的 config（DSH 官方机制：apply(ctx, config)）。 */
export function setRuntimeConfig(config) {
  const before = JSON.stringify(loadConfig())
  runtimeConfig = (config && typeof config === 'object' && !Array.isArray(config)) ? config : null
  if (before !== JSON.stringify(loadConfig())) dispose()
}

/**
 * 面板改完配置后由 `loader/volatile-update` 监听器调用。
 * 值此时已经写进 Volatile 引用，无需再解包；这里只丢掉派生的缓存
 * （store 解析结果、活动索引、热词表、子进程），让下一次调用按新路径重建。
 */
export function onVolatileUpdate() {
  const before = JSON.stringify(loadConfig())
  // 权威值已进入 Volatile 引用，乐观覆盖层可以退场。
  configOverride = null
  dispose()
  return { before: JSON.parse(before), after: loadConfig() }
}

/**
 * 读取当前生效的 runtime 层配置。每次调用都重新 .get()，
 * 这样 volatile-only 更新（不重启插件行）也能立刻被看到。
 */
export function getRuntimeConfig() {
  return runtimeConfig ? unwrapConfig(runtimeConfig) : null
}

/**
 * 保存后立刻生效的覆盖层：settings.update 写盘是异步事件（loader/volatile-update），
 * 而面板紧接着就会调 state()。把刚写下的 patch 记在这里，loadConfig() 优先采用，
 * 于是「保存并生效」的下一帧就能看到新值，不必等事件、更不必重开面板。
 * volatile 事件到达时（onVolatileUpdate）清空，回到引用里的权威值。
 */
let configOverride = null

export function setConfigOverride(patch) {
  configOverride = patch && typeof patch === 'object' ? { ...patch } : null
  dispose()
}

/**
 * 插件根目录（profile 面板写 config.local.json 时需要）。
 * 可被 SEKAISYNC_CONFIG_DIR 覆盖：既方便同一份代码服务多个实例，
 * 也让测试能把配置写到临时目录而不碰真实部署。
 */
export function getPluginRoot() {
  const override = process.env.SEKAISYNC_CONFIG_DIR
  return override ? resolve(override) : pluginRoot
}

export function loadConfig() {
  const cfg = { store: null, root: null, python: 'python', externalPort: 8787, maxResponseBytes: 128 * 1024 * 1024 }
  const configDir = getPluginRoot()
  for (const filename of ['config.json', 'config.local.json']) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(join(configDir, filename), 'utf8')))
    } catch { /* Optional defaults or machine-local overrides. */ }
  }
  if (process.env.SEKAISYNC_CONFIG) {
    try { Object.assign(cfg, JSON.parse(readFileSync(process.env.SEKAISYNC_CONFIG, 'utf8'))) } catch { /* 忽略坏配置 */ }
  }
  if (runtimeConfig) {
    // 每次都重新解包：volatile-only 更新就地改写引用，不重启插件行。
    const current = unwrapConfig(runtimeConfig)
    for (const k of ['store', 'root', 'python', 'externalPort', 'maxResponseBytes']) {
      const v = current[k]
      // 空字符串与 0 都视为「该层未设置」，让下层的 config.local.json / 环境变量生效。
      // （Config schema 的 python 默认 ''、externalPort 默认 0，正是为了让 schema 默认值
      //  不至于遮蔽文件层；这里的空值语义与 schema 保持一致。）
      if (v !== undefined && v !== null && v !== '' && v !== 0) {
        cfg[k] = v
      }
    }
  }
  // 刚保存、事件尚未到达时的乐观覆盖层（见 setConfigOverride）。
  if (configOverride) {
    for (const k of ['store', 'root']) {
      const v = configOverride[k]
      if (v !== undefined && v !== null && v !== '') cfg[k] = v
    }
  }
  if (process.env.SEKAISYNC_STORE) cfg.store = process.env.SEKAISYNC_STORE
  if (process.env.SEKAISYNC_ROOT) cfg.root = process.env.SEKAISYNC_ROOT
  if (process.env.SEKAISYNC_PYTHON) cfg.python = process.env.SEKAISYNC_PYTHON
  if (process.env.SEKAISYNC_PORT) cfg.externalPort = Number(process.env.SEKAISYNC_PORT)
  if (process.env.SEKAISYNC_MAX_RESPONSE_BYTES) cfg.maxResponseBytes = Number(process.env.SEKAISYNC_MAX_RESPONSE_BYTES)
  return cfg
}

export function resolveStore(cfg) {
  const cached = cachedStore(cfg)
  if (cached) return cached
  if (cfg.store) {
    const p = resolve(cfg.store)
    if (existsSync(join(p, 'kb'))) return rememberStore(cfg, p)
    throw new Error(`store 不存在或缺少 kb/ 目录：${p}（请检查 config.json 或 SEKAISYNC_STORE）`)
  }
  const bases = []
  if (cfg.root) bases.push(resolve(cfg.root))
  bases.push(process.cwd(), homedir(), join(homedir(), '.dsh'), pluginRoot)
  for (const base of bases) {
    const store = join(base, 'store')
    if (existsSync(join(store, 'kb'))) return rememberStore(cfg, store)
    try {
      const r = spawnSync(cfg.python, ['-c',
        'import sekaisync,os;print(os.path.dirname(os.path.dirname(os.path.abspath(sekaisync.__file__))))'],
        { cwd: base, encoding: 'utf8', timeout: 15_000, windowsHide: true })
      if (r.status === 0 && r.stdout) {
        const root = r.stdout.trim()
        if (root && existsSync(join(root, 'store', 'kb'))) return rememberStore(cfg, join(root, 'store'))
      }
    } catch { /* 继续探测 */ }
  }
  throw new Error('未找到 sekaisync 知识库 store。请在插件目录 config.json 设置 "store"，或用 SEKAISYNC_STORE 环境变量。')
}

// Keep the synchronous discovery helper for existing scripts; runtime requests
// discover asynchronously and reuse the successful path on all cache checks.
async function resolveStoreAsync(cfg) {
  const cached = cachedStore(cfg)
  if (cached) return cached
  if (cfg.store) return resolveStore(cfg)
  const bases = [...new Set([cfg.root && resolve(cfg.root), process.cwd(), homedir(), join(homedir(), '.dsh'), pluginRoot].filter(Boolean))]
  for (const base of bases) {
    const store = join(base, 'store')
    if (existsSync(join(store, 'kb'))) return rememberStore(cfg, store)
  }
  const key = storeConfigKey(cfg)
  if (discoveringStore?.key === key) return discoveringStore.promise
  const epoch = lifecycle
  const signal = backgroundController.signal
  const entry = { key }
  discoveringStore = entry
  entry.promise = (async () => {
    for (const base of bases) {
      signal.throwIfAborted()
      try {
        const r = await runCommand(cfg.python, ['-c',
          'import sekaisync,os;print(os.path.dirname(os.path.dirname(os.path.abspath(sekaisync.__file__))))'],
        { cwd: base, timeout: 15_000, maxBuffer: 64 * 1024, signal })
        const store = join(r.stdout.trim(), 'store')
        if (r.stdout.trim() && existsSync(join(store, 'kb'))) {
          if (epoch !== lifecycle) throw new DOMException('Disposed', 'AbortError')
          return rememberStore(cfg, store)
        }
      } catch { signal.throwIfAborted() }
    }
    throw new Error('未找到 sekaisync 知识库 store。请设置 config.json store 或 SEKAISYNC_STORE。')
  })().finally(() => { if (discoveringStore === entry) discoveringStore = null })
  return entry.promise
}

// ── 子进程管理 ──
let child = null
let port = 0
let external = false
let starting = null
let stopped = false
let outputBuf = ''
let lastSpawnAt = 0
let crashCount = 0
let deathAt = 0
let lastError = null
let externalCheckedAt = 0
let serverIdentity = ''
let lifecycle = 0
let backgroundController = new AbortController()

function cacheScope(cfg, store) {
  const stamps = ['sekaisync.db', 'sekaisync.db-wal', 'registry.json', 'freshness.json'].map((name) => {
    try {
      const s = statSync(join(store, 'kb', name), { bigint: true })
      return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
    } catch { return '-' }
  })
  return JSON.stringify([store, cfg.root, cfg.python, cfg.externalPort, cfg.maxResponseBytes, ...stamps])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// /health 的成本取决于上游版本：
//   - 0.4.0-alpha（d4cf781 之前）：ready() 是 @request_scoped，每次探测都要重载
//     并 deepcopy 整个 registry（71,555 实体），实测 21–40s；此时 1.2/1.5s 的
//     探测必然失败，且密集重试会把服务槽位（MAX_CONCURRENT_REQUESTS=16）吃光，
//     反过来饿死真实查询（实测 lookup 20.7s→90s 超时且不自愈）。
//   - d4cf781 起：ready() 不再 request_scoped，/health 实测 3–35ms。
// 预算给大对修复后的服务器零成本（无服务器时是 instant ECONNREFUSED，
// 不会空等），却让本插件对「修复前」的服务器也可用。故按大值取。
const PROBE_EXTERNAL_MS = 30_000  // 复用外部端口时的健康确认
const PROBE_MANAGED_MS = 60_000   // 子进程就绪确认
const MAX_READY_ATTEMPTS = 2      // 就绪探测次数上限（少而宽，避免探测风暴）

async function probeHealth(url, timeoutMs = 1500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'error' })
    if (!res.ok) { await res.body?.cancel(); return false }
    const j = JSON.parse((await readBoundedText(res, 64 * 1024)).text)
    return !!(j && j.status === 'ok' && j.ready === true)
  } catch { return false } finally { clearTimeout(t) }
}

function tail(n = 1200) {
  const s = outputBuf.replace(/\s+$/g, '').slice(-n)
  return s ? '\n--- 服务器输出 ---\n' + s : ''
}

function spawnServer(cfg, store) {
  return new Promise((resolveOk, reject) => {
    const epoch = lifecycle
    const root = cfg.root || dirname(store)
    const proc = spawn(cfg.python, ['-u', '-m', 'sekaisync', '--no-event-check', '--store', store,
      'serve-http', '--host', '127.0.0.1', '--port', '0'],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    let settled = false
    const ok = (p) => { if (!settled) { settled = true; resolveOk(p) } }
    const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg + tail())) } }
    const timer = setTimeout(() => {
      fail(`sekaisync 服务器启动超时（${START_TIMEOUT_MS / 1000}s）`)
      proc.kill()
    }, START_TIMEOUT_MS)
    let banner = ''
    proc.stdout.on('data', (d) => {
      outputBuf = (outputBuf + d.toString()).slice(-16000)
      banner = (banner + d.toString()).slice(-4096)
      const m = banner.match(/127\.0\.0\.1:(\d+)/)
      if (m && !settled) { clearTimeout(timer); ok(Number(m[1])) }
    })
    proc.stderr.on('data', (d) => { outputBuf = (outputBuf + d.toString()).slice(-16000) })
    proc.on('error', (e) => { clearTimeout(timer); fail(`无法启动 python（${cfg.python}）：${e.message}（请确认已安装 sekaisync，或设置 SEKAISYNC_PYTHON）`) })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (child === proc) { child = null; port = 0 }
      if (!settled) fail(`sekaisync 服务器提前退出（code=${code}）`)
      else if (epoch === lifecycle && !stopped) { crashCount += 1; deathAt = Date.now() }
    })
    child = proc
    lastSpawnAt = Date.now()
  })
}

/**
 * 确保托管/外部服务可用，返回 { port, external, store }。
 * 面板的「测试连接」需要直接对 `/health` 发请求（该端点在根路径，不属 /api/v1），
 * 因此这里把内部实现导出，而不是让面板去猜端口。
 */
export async function ensureServer() {
  if (starting) return starting
  const epoch = lifecycle
  starting = (async () => {
    stopped = false
    const cfg = loadConfig()
    const store = await resolveStoreAsync(cfg)
    if (!Number.isInteger(Number(cfg.externalPort)) || cfg.externalPort < 0 || cfg.externalPort > 65535) {
      throw new Error('externalPort 必须是 0–65535 的整数（0=跳过外部探测）')
    }
    const identity = JSON.stringify([store, cfg.root, cfg.python, cfg.externalPort])
    if (serverIdentity && serverIdentity !== identity) {
      if (child?.exitCode === null) child.kill()
      child = null; port = 0; external = false
    }
    serverIdentity = identity
    if (child && child.exitCode === null && port) return { port, external, store }
    if (external && port && Date.now() - externalCheckedAt < 5000) return { port, external, store }
    if (crashCount >= 2 && Date.now() - deathAt < 60_000) {
      throw new Error(`sekaisync 服务器 60 秒冷却期内不自动重启（已连续崩溃 ${crashCount} 次）。请检查 python 环境与 store 完整性。${tail()}`)
    }
    if (Number(cfg.externalPort) > 0 && await probeHealth(`http://127.0.0.1:${cfg.externalPort}/health`, PROBE_EXTERNAL_MS)) {
      if (epoch !== lifecycle) throw new DOMException('Disposed', 'AbortError')
      external = true; port = cfg.externalPort
      externalCheckedAt = Date.now()
      return { port, external, store }
    }
    if (epoch !== lifecycle) throw new DOMException('Disposed', 'AbortError')
    external = false
    try {
      const p = await spawnServer(cfg, store)
      // spawnServer 已等到达「listening on」横幅，端口即刻可用。
      // 探测策略：少量、每次给足预算（而不是密集短探测），理由见上方 PROBE_* 注释。
      let ready = false
      for (let attempt = 0; attempt < MAX_READY_ATTEMPTS && !ready; attempt++) {
        if (epoch !== lifecycle) throw new DOMException('Disposed', 'AbortError')
        if (attempt > 0) await sleep(1_000)
        ready = await probeHealth(`http://127.0.0.1:${p}/health`, PROBE_MANAGED_MS)
      }
      if (epoch !== lifecycle) throw new DOMException('Disposed', 'AbortError')
      // 未确认就绪也照旧乐观放行：端口已记下，ensureServer 下次会短路到
      // child+port 直接发真实请求，由真实调用的错误来说话——比在这里抛错
      // 更贴近上游「横幅即就绪」的原意，也避免把一次迟到的 /health 变成硬失败。
      port = p
      crashCount = 0
      lastError = null
      warmupAliasMap().catch(() => {})  // 服务就绪后后台预热活动索引
      warmupLexicon().catch(() => {})   // 0.4.0-alpha：后台预热动态热词表
      return { port, external, store }
    } catch (e) {
      lastError = e.message
      throw e
    }
  })().finally(() => { if (epoch === lifecycle) starting = null })
  return starting
}

/** 停止插件时释放子进程。 */
export function dispose() {
  lifecycle++
  stopped = true
  if (child && child.exitCode === null) {
    try { child.kill() } catch { /* 忽略 */ }
  }
  child = null; port = 0; external = false
  starting = null; serverIdentity = ''; externalCheckedAt = 0
  resolvedStoreCache = null; discoveringStore = null
  memo.clear(); requests.clear()
  backgroundController.abort()
  backgroundController = new AbortController()
  aliasMapCache = null
  lexiconCache = null; lexiconSource = 'static'
}

// ── 参数收敛（P15 边界）────────────────────────────────────────────────
function clampLimit(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < 1) return 1
  return Math.min(i, MAX_LIMIT)
}

function normalizeRegions(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',')
  const out = list.map((r) => String(r).trim().toLowerCase()).filter((r) => REGION_KEYS.has(r))
  return out.length ? out.join(',') : undefined
}

/**
 * 把工具参数收敛到上游 P15 预算内。
 * 过滤空值（避免触发 empty_to_none 边界）、截断超长 query、夹紧 limit、
 * 归一如 region 这类枚举，其余原样透传。
 * 语言键**不改写**：只拒绝明显非法的值，让上游如实回答覆盖情况。
 */
export function sanitizeParams(method, params) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(method)) throw new Error('非法 API 方法名')
  const out = Object.create(null)
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue
    let val = v
    if (k === 'limit') { val = clampLimit(v, 8); if (val === undefined) continue }
    else if (k === 'query' && typeof v === 'string') val = v.slice(0, MAX_QUERY_LENGTH)
    else if (k === 'entity_id' && typeof v === 'string') val = v.slice(0, 256)
    else if (k === 'region' || k === 'regions') { const r = normalizeRegions(v); if (!r) continue; val = r }
    else if (k === 'source_language' || k === 'language' || k === 'target_language') {
      const s = String(v).trim().toLowerCase()
      if (!KNOWN_LANGUAGES.has(s)) continue
      val = s
    }
    else if (k === 'max_text_chars') {
      const n = Number(v)
      val = Number.isFinite(n) ? Math.min(Math.max(0, Math.trunc(n)), MAX_TEXT_CHARS) : 0
    }
    if (typeof val === 'object' || typeof val === 'function' || typeof val === 'symbol') {
      throw new Error(`参数 ${k} 必须是字符串、数字或布尔值`)
    }
    if (k.length > 128 || (typeof val === 'string' && val.length > MAX_QUERY_LENGTH)) {
      throw new Error(`参数 ${k.slice(0, 128)} 超出长度预算`)
    }
    out[k] = val
  }
  return out
}

// ── 会话内结果缓存（TTL；同 query 重复触发零成本）──
const memo = new ByteLru()
const requests = new RequestPool()
let memoScope = ''
const METHOD_TTL = {
  lookup: 60_000,
  fact_pack: 60_000,
  resolve: 300_000,
  term_lookup: 300_000,
  term_penetrate: 600_000, // 实测 43–99s，是当前最贵的查询之一
  web_lookup: 600_000,     // 剧情索引加载重，缓存 10 分钟
  freshness: 30_000,
  progress: 300_000,
  data_gaps: 300_000,
  activity: 60_000,
  event_alias: 60_000,
  worldlink: 60_000,
  event_archive: 60_000,
  news: 120_000,
}

function memoKey(method, params) {
  const p = Object.create(null)
  for (const [k, v] of Object.entries(params || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (v === undefined || v === null || v === '') continue
    p[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  return method + ':' + JSON.stringify(p)
}

/**
 * 把调用方的取消信号与插件自己的超时预算合成为一个信号。
 * Harness 0.1.7 的取消是协作式的：每个工具体都收到 exec.signal 且必须观测它。
 * 只用插件自己的 AbortController 会让「用户点了停止」后请求仍在跑。
 */
function linkSignals(callerSignal, timeoutMs) {
  return deadlineSignal(callerSignal, timeoutMs)
}

async function callRaw(method, clean, signal) {
  signal.throwIfAborted()
  const { port: p } = await waitWithSignal(ensureServer(), signal)
  signal.throwIfAborted()
  const qs = Object.keys(clean).length ? '?' + new URLSearchParams(clean) : ''
  const res = await fetch(`http://127.0.0.1:${p}/api/v1/${method}${qs}`, { signal, redirect: 'error' })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await readBoundedText(res, 4096, { truncate: true })).text.slice(0, 400)}`)
  const maxBytes = Number(loadConfig().maxResponseBytes)
  if (!Number.isInteger(maxBytes) || maxBytes < 64 * 1024 || maxBytes > 1024 * 1024 * 1024) {
    await res.body?.cancel()
    throw new Error('maxResponseBytes 必须为 65536–1073741824 字节的整数')
  }
  let body
  try { body = await readBoundedText(res, maxBytes) } catch (e) {
    if (e.message.includes('字节预算')) throw new Error(`${e.message}；可缩小 limit/max_text_chars，或配置 SEKAISYNC_MAX_RESPONSE_BYTES`)
    throw e
  }
  signal.throwIfAborted()
  return { data: JSON.parse(body.text), bytes: body.bytes }
}

/** 统一调用入口：会话内缓存 + managed 子进程死亡时自动重启重试一次。 */
export async function call(method, params, { timeoutMs = 30_000, retried = false, noCache = false, signal } = {}) {
  const budget = linkSignals(signal, timeoutMs)
  try {
    budget.signal.throwIfAborted()
    const clean = sanitizeParams(method, params)
    const cfg = loadConfig()
    const store = await waitWithSignal(resolveStoreAsync(cfg), budget.signal)
    const scope = cacheScope(cfg, store)
    if (memoScope !== scope) { memo.clear(); memoScope = scope }
    const key = memoKey(method, clean)
    if (!noCache) {
      const hit = memo.get(key)
      if (hit !== undefined) return hit
    }
    const epoch = lifecycle
    return await requests.run(noCache ? Symbol() : `${scope}:${key}`, async (upstreamSignal) => {
      let response
      try {
        response = await callRaw(method, clean, upstreamSignal)
      } catch (e) {
        // Retry only a dead managed process, under the same caller deadline.
        if (upstreamSignal.aborted || external || retried || e.name !== 'TypeError' || child?.exitCode === null) throw e
        child = null; port = 0
        response = await callRaw(method, clean, upstreamSignal)
      }
      if (!noCache && epoch === lifecycle && scope === memoScope && scope === cacheScope(cfg, store)) {
        memo.set(key, response.data, METHOD_TTL[method] ?? 60_000, response.bytes)
      }
      return response.data
    }, budget.signal)
  } catch (e) {
    // 调用方主动取消：如实上报，不要误报成超时，也不要重试。
    if (signal && signal.aborted) throw new Error(`${method} 已取消（调用方中止）`)
    if (budget.signal.aborted && budget.signal.reason?.name === 'TimeoutError') throw new Error(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`)
    throw e
  } finally { budget.cleanup() }
}

/**
 * `resolve` 的中文变体回退。
 *
 * 上游 tools.py 的默认 target_language 是 `zh_tw`，但 v3 store 的实体名与译名槽
 * 用 `zh_hant`：实测 `target_language=zh_tw` 对 character:1 返回
 * `translation_status=missing`、`target_name=null`，而 `zh_hant` 返回「星乃一歌」。
 * 静默改写会让调用方失去「上游确实没这个语言」的信息，所以这里：
 *   ① 先按调用方给的语言如实查询；
 *   ② 仅当**全部**结果都是「未覆盖」时，才用变体重试一次；
 *   ③ 把实际命中的语言挂在返回值上（_language_fallback），由压缩器如实告知模型。
 * 这样「上游未覆盖」与「键名不一致」两种情况都能被区分，而不是被抹平。
 */
export async function resolveWithFallback(params, { timeoutMs = 110_000, signal } = {}) {
  const startedAt = Date.now()
  const first = await call('resolve', params, { timeoutMs, signal })
  const rows = (first && first.results) || []
  const anyCovered = rows.some((r) => r.target_name != null || (r.translation_status && r.translation_status !== 'missing'))
  const variant = LANGUAGE_VARIANTS[String(params.target_language || '').toLowerCase()]
  if (anyCovered || !variant || !rows.length) return first
  const remaining = timeoutMs - (Date.now() - startedAt)
  if (remaining <= 0) return first
  const retry = await call('resolve', { ...params, target_language: variant }, { timeoutMs: remaining, signal }).catch((e) => {
    if (signal?.aborted) throw e
    return null
  })
  const retryRows = (retry && retry.results) || []
  const retryCovered = retryRows.some((r) => r.target_name != null)
  if (!retryCovered) return first // 上游确实未覆盖：保留原样，让 compactResolve 如实标注
  return { ...retry, _language_fallback: { requested: params.target_language, effective: variant } }
}

/** 供 sekai_status 使用的运行时元信息；就绪等待也包含在总预算中。 */export async function status({ signal } = {}) {
  const budget = linkSignals(signal, 170_000)
  try {
    budget.signal.throwIfAborted()
    const meta = await waitWithSignal(ensureServer(), budget.signal)
    const [freshness, progress, gaps] = await Promise.all(['freshness', 'progress', 'data_gaps'].map((method) =>
      call(method, null, { timeoutMs: 30_000, signal: budget.signal }).catch((e) => {
        if (budget.signal.aborted) throw e
        return null
      })))
    return { data: freshness, meta, progress, gaps }
  } finally { budget.cleanup() }
}

// ── 全量活动索引（官方 CLI 构建；支撑官方箱活名反查 + 真实别名词表）──
let aliasMapCache = null
let aliasMapAt = 0
const ALIAS_MAP_TTL = 30 * 60_000

/** 规范化：去空白/引号/括号/标点，NFC 折叠大小写。 */
function normalizeAliasText(s) {
  return String(s || '').normalize('NFC').toLowerCase()
    .replace(/[\s"'“”‘’「」『』()（）・。.,，、\-–—!！?？:：;；&＆+＋/\\]/g, '')
}

/** 构建全量箱活索引：别名键表 + 各服官方箱活名 → {角色, 序号} 反查表。 */
async function buildAliasIndex(regionsKey, signal) {
  const cfg = loadConfig()
  const store = await waitWithSignal(resolveStoreAsync(cfg), signal)
  const r = await runCommand(cfg.python, ['-u', '-m', 'sekaisync', '--no-event-check', '--store', store,
    'alias', '--list', '--regions', regionsKey],
  { cwd: cfg.root || dirname(store), signal, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })
  let map
  try { map = JSON.parse(r.stdout) } catch (e) { throw new Error('活动索引解析失败：' + e.message) }
  const byName = new Map()          // 规范化官方名 -> {charId, ordinal}
  const aliasKeys = new Set()       // 服务端真实别名词表
  for (const [charIdStr, info] of Object.entries(map.characters || {})) {
    for (const a of (info.aliases || [])) { const k = normalizeAliasText(a); if (k) aliasKeys.add(k) }
    for (const box of (info.box_events || [])) {
      for (const [, rd] of Object.entries(box.regions || {})) {
        const n = normalizeAliasText(rd && rd.name)
        if (!n) continue
        if (!byName.has(n)) {
          byName.set(n, { charId: parseInt(charIdStr, 10), ordinal: box.ordinal })
        }
      }
    }
  }
  // tms/tks 同角色：aliases 重复 ID 已合并；按长度降序避免前缀误命中
  const sortedKeys = [...aliasKeys].filter(Boolean).sort((a, b) => b.length - a.length)
  return { map, byName, aliasKeys: sortedKeys, regionsKey }
}

async function loadAliasIndex(regions) {
  const key = normalizeRegions(regions) || DEFAULT_REGIONS
  const cfg = loadConfig()
  const store = await resolveStoreAsync(cfg)
  const scope = cacheScope(cfg, store)
  if (aliasMapCache && aliasMapCache.scope === scope && aliasMapCache.regionsKey === key && Date.now() - aliasMapAt < ALIAS_MAP_TTL) {
    return Promise.resolve(aliasMapCache)
  }
  const epoch = lifecycle
  return requests.run(`alias-index:${scope}:${key}`, async (signal) => {
    const ctx = await buildAliasIndex(key, signal)
    if (epoch === lifecycle && scope === cacheScope(cfg, store)) {
      aliasMapCache = { ...ctx, scope }
      aliasMapAt = Date.now()
    }
    return ctx
  }, backgroundController.signal)
}

/** 后台预热（幂等；失败静默，下次查询时按需重建）。 */
export function warmupAliasMap() {
  return loadAliasIndex().catch(() => undefined)
}

/** 从查询里提取「别名键+序号」候选（用服务端真实别名词表）。 */
function aliasKeyCandidates(query, aliasKeys) {
  const out = []
  const q = normalizeAliasText(query)
  if (!q) return out
  for (const key of aliasKeys) {
    const idx = q.indexOf(key)
    if (idx < 0) continue
    const rest = q.slice(idx + key.length).replace(/^第/, '').replace(/^个/, '')
    const m = rest.match(/^([0-9０-９一二三四五六七八九十]+)(?:箱活|箱|活)?/)
    if (m && /[0-9０-９一二三四五六七八九十]/.test(m[1])) {
      out.push(key + m[1] + (m[2] || ''))
    }
  }
  return out
}

/** 官方箱活名反查：命中则返回与简称一致的 box 结构（kind='box'）。 */
function resolveByOfficialName(query, ctx) {
  const q = normalizeAliasText(query)
  if (!q) return null
  let best = null
  for (const [n, ref] of ctx.byName) {
    let score = 0
    if (n === q) score = 1000
    else if (q.includes(n)) score = 600 + n.length
    else if (n.includes(q)) score = 400 + q.length
    if (score > (best ? best.score : -1)) best = { score, ref, name: n }
  }
  if (!best || best.score < 400) return null
  const idStr = String(best.ref.charId)
  const info = ctx.map.characters[idStr]
  const box = (info?.box_events || []).find((b) => b.ordinal === best.ref.ordinal)
  if (!info || !box) return null
  return {
    query,
    alias: (box.regions.jp && box.regions.jp.name) || best.name,
    character: { id: best.ref.charId, unit: info.unit, names: info.names },
    ordinal: best.ref.ordinal,
    mapping: box.regions,
    confidence: best.score >= 1000 ? 'high' : 'medium',
    matchedBy: 'official_name',
    method: 'official_name_lookup',
    kind: 'box',
  }
}

// ── 社区活动简称：候选提取 + 确定性探测（不依赖模型路由判断）──
// parse_query 只接受纯「别名+序号[+箱/活]」；自然问句必须先提取出候选再探测。
const NUMERAL_RE = /[0-9０-９一二三四五六七八九十]/
const TRAILING_PARTICLE_RE = /(?:的|第|个|回|场|期)+$/g
const WL_HINT_RE = /wl|finale|round/i

export function looksLikeAliasQuery(query) {
  const q = String(query || '')
  return (NUMERAL_RE.test(q) && /箱|活/.test(q)) || WL_HINT_RE.test(q)
}

export function aliasCandidates(query) {
  const q = String(query || '').replace(/\s+/g, '').toLowerCase()
  const out = []
  const push = (c) => { if (c && !out.includes(c)) out.push(c) }
  push(q)
  const latin = /^[a-z0-9０-９]+/.exec(q)
  if (latin) push(latin[0])
  const idx = q.search(NUMERAL_RE)
  if (idx > 0) {
    const tail = q.slice(idx).match(new RegExp('^[0-9０-９一二三四五六七八九十]+(?:箱活|箱|活)?'))
    if (tail) push(q.slice(0, idx).replace(TRAILING_PARTICLE_RE, '') + tail[0])
  }
  return out.slice(0, 4)
}

/** 统一活动解析：① 简称候选（含真实别名词表提取）→ ② 官方箱活名反查。
 *  优先走新统一端点 /activity（WL + 箱活 + unresolved）；旧版服务器自动回退 /event_alias（仅箱活）。 */
export async function resolveAlias(query, regions, timeoutMs = 15_000, signal) {
  if (!query) return null
  const budget = linkSignals(signal, timeoutMs)
  try {
    budget.signal.throwIfAborted()
    query = String(query).slice(0, MAX_QUERY_LENGTH)
    const cands = aliasCandidates(query)
    let ctx = null
    try { ctx = await waitWithSignal(loadAliasIndex(regions), budget.signal) } catch {
      budget.signal.throwIfAborted() // 索引不可用则退化为纯简称路径
    }
    if (ctx) for (const c of aliasKeyCandidates(query, ctx.aliasKeys)) if (!cands.includes(c)) cands.push(c)
    for (const cand of cands) {
      try {
        const act = await call('activity', { query: cand, regions }, { timeoutMs, signal: budget.signal })
        if (act && act.kind && act.kind !== 'unresolved') return act
      } catch { budget.signal.throwIfAborted() }
      try {
        const box = await call('event_alias', { query: cand, regions }, { timeoutMs, signal: budget.signal })
        if (box && box.mapping) return { ...box, kind: 'box' }
      } catch { budget.signal.throwIfAborted() }
    }
    if (ctx) return resolveByOfficialName(query, ctx)
    return null
  } catch (e) {
    if (signal?.aborted) throw new Error('activity 已取消（调用方中止）')
    if (budget.signal.aborted) throw new Error(`activity 超时（${Math.round(timeoutMs / 1000)}s）`)
    throw e
  } finally { budget.cleanup() }
}

export function compactAlias(data) {
  if (!data) return '未找到匹配的活动——支持社区简称（khn3 / 豆三箱 / 心羽3）与官方箱活名（各服官方名均可，如「雨过天晴的启明星」），World Link 见 sekai_alias 描述。也可用 sekai_lookup 按活动官方名查事件详情。'
  const c = data.character || {}
  const names = compactNames(c.names)
  const lines = [`${data.query} → ${data.alias}（第 ${data.ordinal} 个箱活，${data.confidence}）`, `character: ${c.id} ${c.unit || ''} ${names}`]
  for (const [region, m] of Object.entries(data.mapping || {})) {
    const date = m.start_at ? new Date(m.start_at).toISOString().slice(0, 10) : ''
    lines.push(`${region}: event_id=${m.event_id} 「${m.name}」${date} 曲=[${shortList(m.songs, 3)}] 卡=[${shortList(m.cards, 3)}]`)
  }
  return cut(lines.join('\n'), 5000)
}

export function compactWl(data) {
  if (!data) return '未找到匹配的 World Link 简称（支持 wl3、lnwl、vbs wl2、25wl、vs wl、finale、round2、wl3gN 等）'
  const lines = []
  // 0.4.0-alpha 的 /activity 对 WL 有两种形状：整轮（kind='wl' + round + events）
  // 与单条（code/subtype/unit_name）。后者在 activity 端点下也可能以 round 形式出现。
  if (data.code) {
    lines.push(`${data.code} [${data.subtype}] ${data.unit_name || data.unit || ''} 「${data.name || ''}」event_id=${data.event_id}`)
    if (data.aliases && data.aliases.length) lines.push(`aliases: ${data.aliases.join(', ')}`)
    if (data.round && data.round.round) lines.push(`round ${data.round.round}（该轮共 ${(data.round.events || []).length} 个 WL）`)
    for (const [region, r] of Object.entries((data.mapping && data.mapping.regions) || {})) {
      const date = r.start_at ? new Date(r.start_at).toISOString().slice(0, 10) : ''
      lines.push(`${region}: 「${r.name || ''}」${date}`)
    }
  } else if (data.round && Array.isArray(data.events)) {
    lines.push(`World Link 第 ${data.round} 轮（${data.events.length} 个活动）${data.confidence ? ` ${data.confidence}` : ''}`)
    for (const e of data.events) {
      const date = e.start_at ? new Date(e.start_at).toISOString().slice(0, 10) : ''
      lines.push(`  ${e.code} [${e.subtype}] ${e.unit || ''} 「${e.name || ''}」${date} event_id=${e.event_id}`)
    }
  } else {
    return '（无法识别的 World Link 结果）'
  }
  return cut(lines.join('\n'), 5000)
}

// ── 动态热词表（SekaiSync 0.4.0-alpha）────────────────────────────────
// 上游 docs/DSH_PLUGIN_GUIDE.md §2.1：静态手写角色名数组改为「启动时从 store 构建」。
// 数据来源：官方 CLI `terms export --format json`（一次调用拿到全量 tag/weight/
// occurrences/多语名，约 2s / 2.3MB，零第三方依赖、与 alias --list 同一条路径）。
// 分档（按上游指南）：
//   tag in {person, event} 且 weight Top N  → tier 3
//   tag in {product, location, organization} → tier 2
//   tag == other                            → tier 1
// 跨作品名（Vocaloid 六子等）一律按 product/other 处理，需与 person/event 共现才升为 yes。
const LEXICON_TTL = 30 * 60_000
const LEXICON_STRONG_LIMIT = 2000
const CROSS_WORK = new Set([
  '初音ミク', 'miku', 'hatsune miku', '鏡音リン', '鏡音レン', 'リン', 'レン', 'rin', 'len',
  '巡音ルカ', 'luka', 'meiko', 'kaito', 'vocaloid', 'バーチャル・シンガー',
])

let lexiconCache = null
let lexiconAt = 0
let lexiconSource = 'static'
let lexiconCheckedAt = 0

/** 与上游 normalize.py:normalize_name 同构的 JS 版本（NFKC + casefold + 去噪）。 */
function normalizeText(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[\s_\-.,，。！？!?·•×:：;；'"`~～【】\[\]()（）/\\]+/g, '')
}

function isCrossWork(canonical) {
  const key = normalizeText(canonical)
  if (CROSS_WORK.has(key)) return true
  // 名称里带「初音」「鏡音」「巡音」等跨作品前缀的也按跨作品处理
  return /^(初音|鏡音|镜音|巡音|meiko|kaito)/i.test(key)
}

/**
 * 分档（上游 DSH_PLUGIN_GUIDE §2.1）：
 *   tag in {person, event} 且 weight 在 Top N  → 3
 *   tag in {person, event} 但 weight 未进 Top N → 2（弱一档，不足以免费判定）
 *   tag in {product, location, organization}   → 2
 *   其余（other）                              → 1
 * 跨作品名一律降到 ≤2，需与 person/event 共现才可能升为 yes。
 */
function tierFor(tags, inTopWeight) {
  if (tags.includes('person') || tags.includes('event')) return inTopWeight ? 3 : 2
  if (tags.includes('product') || tags.includes('location') || tags.includes('organization')) return 2
  return 1
}

function routeFor(entry) {
  const t = entry.tags
  if (t.includes('event') && t.includes('location')) return 'sekai_penetrate'
  if (t.includes('event')) return 'sekai_alias'
  if (t.includes('person')) return 'sekai_lookup'
  return 'sekai_term'
}

/** 从 `terms export` 的 JSON 构建内存热词表（Map<归一化键, entry>）。 */
function buildLexiconFromExport(rows) {
  const sorted = rows
    .filter((r) => r && r.canonical)
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
  const strongCut = sorted.slice(0, LEXICON_STRONG_LIMIT)
  const strongKeys = new Set(strongCut.map((r) => normalizeText(r.canonical)))
  const byKey = new Map()
  for (const r of sorted) {
    const tags = Array.isArray(r.tags) && r.tags.length ? r.tags : ['other']
    const inTopWeight = strongKeys.has(normalizeText(r.canonical))
    const crossWork = isCrossWork(r.canonical)
    const weight = Number(r.weight) || 0
    // 跨作品名降档：不参与「单独命中即 yes」的判定
    const tier = crossWork ? Math.min(tierFor(tags, inTopWeight), 2) : tierFor(tags, inTopWeight)
    const entry = {
      canonical: r.canonical,
      tags,
      weight,
      occurrences: Number(r.occurrences) || 0,
      tier,
      crossWork,
      next_tool: crossWork ? 'sekai_term' : routeFor({ tags }),
    }
    // 键：规范名 + 各语言名（export --languages 带出）
    const keys = [r.canonical, ...Object.values(r.names || {})]
    for (const k of keys) {
      const nk = normalizeText(k)
      if (!nk || nk.length < 2) continue
      const prev = byKey.get(nk)
      if (!prev || prev.weight < weight) byKey.set(nk, entry)
    }
  }
  return byKey
}

async function buildLexicon(signal) {
  const cfg = loadConfig()
  const store = await waitWithSignal(resolveStoreAsync(cfg), signal)
  const r = await runCommand(cfg.python, ['-u', '-m', 'sekaisync', '--no-event-check', '--store', store,
    'terms', 'export', '--format', 'json', '--languages', 'ja,en,zh_hans,zh_hant,ko'],
  { cwd: cfg.root || dirname(store), signal, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 })
  let parsed
  try { parsed = JSON.parse(r.stdout) } catch (e) { throw new Error('热词表解析失败：' + e.message) }
  const rows = Array.isArray(parsed) ? parsed : (parsed.terms || [])
  if (!rows.length) throw new Error('热词表为空（terms export 未返回条目）')
  return { byKey: buildLexiconFromExport(rows), source: 'terms_export', count: rows.length }
}

async function loadLexicon() {
  const cfg = loadConfig()
  const store = await resolveStoreAsync(cfg)
  const scope = cacheScope(cfg, store)
  if (lexiconCache && lexiconCache.scope === scope && Date.now() - lexiconAt < LEXICON_TTL) return Promise.resolve(lexiconCache)
  const epoch = lifecycle
  return requests.run(`lexicon:${scope}`, async (signal) => {
    const ctx = await buildLexicon(signal)
    if (epoch === lifecycle && scope === cacheScope(cfg, store)) {
      lexiconCache = { ...ctx, scope, cfg, store }
      lexiconAt = Date.now()
      lexiconSource = ctx.source
    }
    return ctx
  }, backgroundController.signal)
}

/** 后台预热动态热词表（失败静默，probeSekai 退化为静态词库）。 */
export function warmupLexicon() {
  return loadLexicon().catch(() => undefined)
}

/** 当前热词表状态（供 sekai_status 报告降级情况）。 */
export function lexiconStatus() {
  return {
    source: lexiconSource,
    terms: lexiconCache ? lexiconCache.count : 0,
    ageMs: lexiconCache ? Date.now() - lexiconAt : null,
  }
}

// ── 世界计划内容判定（动态词表打分 + 静态兜底；纯同步、零副作用、常驻内存）──
// 给模型一个低成本的路由探针：先判定「疑似世界计划内容」再决定是否走 sekai_* 工具。
// 命中项带 tag/weight/next_tool，模型可直接据此路由到正确的下一个工具。
const STATIC_LEXICON = {
  strong: [
    '世界计划', '世界計畫', '世界計划', 'プロセカ', 'プロジェクトセカイ', 'project sekai', 'proseka', 'pjsk', 'prsk',
    'leo/need', 'leoneed', 'レオニード', 'more more jump', 'モアモアジャンプ', 'vivid bad squad', 'ビビバス',
    'wonderlands×showtime', 'wonderlands x showtime', 'ワンダーランズ', 'ワンダショ', '25時', 'ナイトコード', 'nightcord', 'ニーゴ', '25ji',
    '星乃一歌', '天马咲希', '天馬咲希', '望月穗波', '望月穂波', '花里实乃理', '花里實乃理', '桐谷遥', '桐谷遙',
    '桃井爱莉', '桃井愛莉', '日野森志步', '日野森志歩', '日野森雫', '小豆泽心羽', '小豆澤心羽', '白石杏',
    '东云彰人', '東雲彰人', '青柳冬弥', '青柳冬彌', '天马司', '天馬司', '凤笑梦', '鳳笑夢', '草薙宁宁', '草薙寧寧',
    '神代类', '神代類', '宵崎奏', '朝比奈真冬', '晓山瑞希', '曉山瑞希',
    // 剧情配角/NPC（仅存在于世界计划剧情语境）
    '凤阳诗', '鳳陽詩', '凤幸之介', '鳳幸之介', '凤庆介', '鳳慶介', '凤晶介', '鳳晶介', '凤乐之介', '鳳楽之介', '乐之介', '笑梦', '笑夢', '心羽',
  ],
  weak: [
    '箱活', 'ワールドリンク', 'world link', 'project message', 'ネットパラダイス',
    'ワンスアポンアドリーム', 'once upon a dream', 'スマイルオブドリーマー', 'smile of a dreamer',
    '雨上がりの一番星', 'first star after the rain', 'ステラ', 'stella', '流星のパルス',
  ],
  patterns: [
    /(?:^|\D)wl\s*[0-9０-９]/i,          // wl3 / Wl 2
    /finale/i, /round\s*[0-9０-９]/i,     // World Link round
    /第\s*[0-9０-９一二三四五六七八九十]+\s*箱/,  // 第3箱
  ],
}

/** 判定查询内容是否为疑似世界计划内容。纯同步、零副作用，返回紧凑结果供模型路由。 */
export function probeSekai(query) {
  // Refresh published generations without blocking a routing probe on the CLI.
  if (lexiconCache && Date.now() - lexiconCheckedAt > 1000) {
    lexiconCheckedAt = Date.now()
    try {
      if (JSON.stringify(lexiconCache.cfg) !== JSON.stringify(loadConfig()) ||
          lexiconCache.scope !== cacheScope(lexiconCache.cfg, lexiconCache.store) || Date.now() - lexiconAt >= LEXICON_TTL) {
        lexiconCache = null; lexiconSource = 'static'
        warmupLexicon().catch(() => {})
      }
    } catch { /* A transient store failure must not break the local fallback. */ }
  }
  query = String(query || '').slice(0, MAX_QUERY_LENGTH)
  const qn = query.normalize('NFC')
  const ql = qn.toLowerCase()
  const nq = normalizeText(qn)
  const hits = []
  const seen = new Set()
  const add = (h) => { if (!seen.has(h.term)) { seen.add(h.term); hits.push(h) } }
  let score = 0
  let hasStrongSignal = false

  if (lexiconCache) {
    for (const [key, entry] of lexiconCache.byKey) {
      if (key.length < 2) continue
      // 精确包含：查询文本里出现完整词条键。
      // 前缀命中：查询是某个较长键的前缀（如 "Solis" → "Solis Records"，
      // 上游指南 §4 的抽样用例正是这种形态）。前缀命中证据较弱，封顶 tier 2。
      const contains = nq.includes(key)
      const prefix = !contains && nq.length >= 4 && key.startsWith(nq)
      if (!contains && !prefix) continue
      const tier = prefix ? Math.min(entry.tier, 2) : entry.tier
      add({
        term: entry.canonical,
        tags: entry.tags,
        weight: entry.weight,
        tier,
        cross_work: entry.crossWork || undefined,
        partial: prefix || undefined,
        next_tool: entry.next_tool,
      })
      score += tier
      // 「单独命中即 yes」需要至少一个非跨作品的 tier>=2 信号，
      // 否则跨作品名（MEIKO/KAITO/初音ミク）会把随便一句歌词判成世界计划内容。
      if (tier >= 2 && !entry.crossWork) hasStrongSignal = true
    }
  } else {
    // 动态词表尚未就绪（或上游 <0.4.0 无 terms export）：退化为静态词库。
    for (const w of STATIC_LEXICON.strong) {
      if (qn.includes(w) || ql.includes(w.toLowerCase())) {
        add({ term: w, tags: ['other'], tier: 3, next_tool: 'sekai_lookup' }); score += 3; hasStrongSignal = true
      }
    }
    for (const w of STATIC_LEXICON.weak) {
      if (qn.includes(w) || ql.includes(w.toLowerCase())) {
        add({ term: w, tags: ['other'], tier: 1, next_tool: 'sekai_term' }); score += 1
      }
    }
  }

  for (const re of STATIC_LEXICON.patterns) {
    if (re.test(qn) || re.test(ql)) { add({ term: `pattern:${re}`, tags: ['event'], tier: 1, next_tool: 'sekai_alias' }); score += 1 }
  }

  hits.sort((a, b) => (b.tier || 0) - (a.tier || 0) || (b.weight || 0) - (a.weight || 0))
  const top = hits.slice(0, 8)
  // 上游指南 §2.3 的用法：event 与 location 同时命中（如「神山高校文化祭」）
  // 说明这是一个「在某地点发生的活动」，单条 term/sentence 不足以确证，
  // 下一步应走跨语言穿透而非简写解析。
  const hasEvent = top.some((h) => h.tags && h.tags.includes('event'))
  const hasLocation = top.some((h) => h.tags && h.tags.includes('location'))
  if (hasEvent && hasLocation) {
    for (const h of top) h.next_tool = 'sekai_penetrate'
  }
  const verdict = (score >= 3 && hasStrongSignal) ? 'yes' : (score >= 1 ? 'maybe' : 'no')
  return { query, score, verdict, hits: top, lexicon: lexiconSource, event_location: hasEvent && hasLocation || undefined }
}

export function compactProbe(p) {
  if (!p.hits.length) return `probe: ${p.query} → no（score=0，无命中）\n词表来源=${p.lexicon}`
  const lines = [`probe: ${p.query} → ${p.verdict}（score=${p.score}，词表来源=${p.lexicon}）`]
  for (const h of p.hits) {
    const tags = h.tags ? h.tags.join('+') : ''
    const w = h.weight !== undefined ? ` w=${h.weight}` : ''
    const cw = h.cross_work ? ' 跨作品' : ''
    lines.push(`• ${h.term} [${tags}]${w}${cw} → ${h.next_tool}`)
  }
  if (p.verdict === 'maybe') lines.push('（maybe：证据不足；可先用 sekai_term 确证用语，或直接 sekai_lookup 试实体）')
  return lines.join('\n')
}

// ── 结果压缩：只把模型需要的紧凑事实送进上下文 ──
export function cut(s, n = 6000) {
  return s.length <= n ? s : s.slice(0, n) + '\n…(截断，请缩小 limit 或换更精确的查询词)'
}

const NAME_KEYS = ['full', 'ja', 'en', 'zh_hans', 'zh_hant', 'zh_tw', 'ko']

function compactNames(names) {
  if (!names || typeof names !== 'object') return ''
  return NAME_KEYS
    .filter((k) => typeof names[k] === 'string' && names[k])
    .map((k) => `${k}=${names[k]}`)
    .join(' ')
}

function compactFacts(facts) {
  if (!facts || typeof facts !== 'object') return ''
  const parts = []
  for (const [k, v] of Object.entries(facts)) {
    if (parts.length >= 10) { parts.push('…'); break }
    if (typeof v === 'string') parts.push(`${k}=${v.length > 48 ? v.slice(0, 48) + '…' : v}`)
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`)
  }
  return parts.join(' ')
}

export function compactLookup(data) {
  const rows = (data && data.results) || []
  if (!rows.length) {
    return `未命中实体库（角色/活动/卡片/卡池/曲目/区域档案）：${data?.query ?? ''}。` +
      `若问的是剧情配角/NPC（如「凤阳诗」），档案库不含此类人物——请用 sekai_web(查询词, 语言) 直接搜剧情全文；` +
      `活动类问题可直接报官方名（sekai_alias 支持箱活名）或用 sekai_resolve 解析官方译名。`
  }
  const out = [`query: ${data.query}`]
  for (const r of rows) {
    const names = compactNames(r.names)
    const facts = compactFacts(r.facts)
    out.push(`• ${r.id} [${r.type}] trust=${r.trust} score=${r.score} regions=${(r.regions || []).join(',')}` +
      (names ? `\n  names: ${names}` : '') + (facts ? `\n  facts: ${facts}` : ''))
  }
  return cut(out.join('\n'), 6000)
}

export function compactFact(pack) {
  if (!pack) return '未找到该实体，请先用 sekai_lookup 确认 id'
  const eff = pack.effective_language ? ` effective_language=${pack.effective_language}` : ''
  const asOf = pack.as_of_iso ? ` as_of=${String(pack.as_of_iso).slice(0, 10)}` : ''
  return cut(pack.text + `\ntrust=${pack.trust}${eff}${asOf} fact_pack_tokens=${pack.fact_pack_tokens}（原始 JSON ${pack.raw_json_tokens}，压缩比 ${pack.token_ratio}）`, 4000)
}

export function compactResolve(data) {
  const rows = (data && data.results) || []
  if (!rows.length) return `无匹配：${data?.query ?? ''}`
  const fb = data && data._language_fallback
  const head = fb ? `（target_language=${fb.requested} 全部未覆盖，已按 ${fb.effective} 重试并命中）\n` : ''
  return head + cut(rows.map((r) => {
    // null target_name means the store has NO name in that language — it is a
    // coverage statement, not an empty string. Rendering it blank (the old
    // `${r.target_name || ''}`) dropped the distinction and left the reader to
    // guess whether a translation exists. canonical_name is a display
    // spelling only: never present it in the target slot.
    const target = r.target_name == null
      ? (r.translation_status === 'missing'
          ? `未覆盖${r.canonical_name ? `（规范名 ${r.canonical_name}）` : ''}`
          : '未知')
      : r.target_name
    return `• ${r.id} [${r.kind}] ${r.source_name || ''} → ${target}（official=${r.official} trust=${r.trust} score=${r.score}）`
  }).join('\n'), 4000)
}

export function compactTerm(data) {
  const rows = (data && data.results) || []
  if (!rows.length) return `无匹配：${data?.query ?? ''}`
  const out = []
  for (const r of rows.slice(0, 8)) {
    // 0.4.0-alpha：kind 之外新增可重叠的 tags 与 weight/occurrences。
    const tags = Array.isArray(r.tags) && r.tags.length ? ` tags=${r.tags.join('+')}` : ''
    const w = r.weight !== undefined ? ` weight=${r.weight}` : ''
    const occ = r.occurrences !== undefined ? ` occ=${r.occurrences}` : ''
    const slots = Array.isArray(r.unverified_languages) && r.unverified_languages.length
      ? ` 未认证语言=${r.unverified_languages.join(',')}` : ''
    out.push(`• ${r.id} [${r.kind || ''}]${tags}${w}${occ} trust=${r.trust || '—'}${slots}\n  ${compactNames(r.names)}`)
    for (const e of (r.evidence || []).slice(0, 2)) {
      const sentence = String(e.sentence || e.context || '').slice(0, 120)
      out.push(`  [${e.story_key} ${e.language}] ${sentence}`)
    }
  }
  return cut(out.join('\n'), 5000)
}

/** 0.4.0-alpha 新增：同点位跨语言穿透（per_language 逐语言 term/sentence/trust）。 */
export function compactPenetrate(data) {
  if (!data || !data.term) return '未找到该用语——请先 sekai_term 确证用语存在，再穿透。'
  const t = data.term
  const tags = Array.isArray(t.tags) && t.tags.length ? t.tags.join('+') : ''
  const lines = [
    `${t.canonical} [${tags}] weight=${t.weight ?? '—'} occ=${t.occurrences ?? '—'} trust=${t.trust || '—'}`,
    `story_key=${data.story_key || '（无）'}${data.released === false ? '（未发布：仅日文线）' : ''}` +
      `${data.cloud_rank ? ` cloud_rank=${data.cloud_rank}` : ''}`,
  ]
  const per = data.per_language || {}
  const langs = Object.keys(per)
  if (!langs.length) {
    lines.push('（该用语没有可用点位，无法穿透）')
    return cut(lines.join('\n'), 4000)
  }
  for (const lang of langs) {
    const v = per[lang] || {}
    // missing:true 是「该语言在这一行没有对应文本」的如实声明，不是错误。
    if (v.missing || (!v.sentence && !v.term)) {
      lines.push(`${lang}: （无对应行${v.trust ? ` trust=${v.trust}` : ''}）`)
      continue
    }
    const term = v.term ? `[${v.term}] ` : ''
    const trust = v.trust ? ` trust=${v.trust}` : ''
    lines.push(`${lang}: ${term}${String(v.sentence || '').replace(/\s+/g, ' ').trim().slice(0, 200)}${trust}`)
  }
  const missing = langs.filter((l) => (per[l] || {}).missing)
  if (missing.length) lines.push(`（${missing.join('/')} 无对应行——译文未覆盖或该行在对应语言中不存在）`)
  return cut(lines.join('\n'), 5000)
}

function shortList(list, n) {
  if (!Array.isArray(list)) return ''
  return list.slice(0, n).join('|') + (list.length > n ? `|…+${list.length - n}` : '')
}

export function compactWeb(data) {
  const rows = (data && data.results) || []
  if (!rows.length) return `剧情全文无匹配：${data?.query ?? ''}。可换其他语言（ja/en/zh_hans/zh_hant/ko）或 source（altsource_sv / altsource_ms）再试，或改用 sekai_lookup/sekai_term。`
  const out = []
  for (const r of rows.slice(0, 12)) {
    const snip = compactExcerpt(r.snippet, 240).text
    const flags = [r.trust ? `trust=${r.trust}` : '', r.untranslated ? '未翻译' : '', r.language || ''].filter(Boolean).join(' ')
    out.push(`• [${r.kind || '?'}] ${r.id} | ${r.source || ''} | ${flags}\n  ${r.title || ''}\n  ${snip}`)
    // include_text：仅在调用方显式索取时出现（上游 0.4.0-alpha 的 web_lookup 参数）。
    const excerpt = compactExcerpt(r.text, 1200)
    if (excerpt.text) out.push(`  text: ${excerpt.text}${excerpt.truncated ? '…' : ''}`)
  }
  if (rows.length > 12) out.push(`…+${rows.length - 12} 条`)
  return cut(out.join('\n'), 8000)
}

// 公告压缩：[tag] 标题（日期，正文 ✓/—）链接 —— 按 body_available 标记可信边界。
export function compactNews(data) {
  const items = (data && data.items) || []
  if (!items.length) return '（无匹配公告）'
  const total = data.count ?? data.matched ?? items.length
  const lines = [`匹配 ${data.matched ?? items.length} 条 / 共 ${total} 条（显示前 ${items.length}）`]
  for (const n of items) {
    const date = (n.published_at || n.start_at || '').slice(0, 10)
    const body = n.body_available ? '正文✓' : '仅链接'
    const tag = n.information_tag || '未分类'
    const type = n.information_type && n.information_type !== 'normal' ? `/${n.information_type}` : ''
    lines.push(`[${tag}${type}] ${n.title}（${date}，${body}）${n.url || ''}`)
  }
  return cut(lines.join('\n'), 3000)
}

export function compactStatus(data, meta, progress, gaps) {
  const lines = [
    `mode=${meta.external ? 'external' : 'managed'} port=${meta.port}`,
    `store=${meta.store}`,
    `ready=${data?.ready} updated_at=${data?.updated_at || '（从未同步）'}`,
  ]
  for (const [region, r] of Object.entries((data && data.regions) || {})) {
    lines.push(`${region}: lang=${r.language} official_translation=${r.official_translation} launch=${r.launch_date || ''}`)
  }
  // 0.4.0-alpha 起 /status 携带 progress（同步率只计「源站确实提供」的内容），
  // progress 端点为毫秒级，成本可忽略且能如实回答「覆盖到什么程度」。
  if (progress && progress.overall) {
    const o = progress.overall
    lines.push(`coverage: fact=${o.fact?.pct ?? '?'}% text=${o.text?.pct ?? '?'}% overall=${o.pct ?? '?'}%（分母口径：可获取内容）`)
    if (o.source_unavailable_units_total) {
      lines.push(`  source_unavailable=${o.source_unavailable_units_total} 单元（源站不提供，已排除在分母外）`)
    }
  }
  if (gaps && Array.isArray(gaps.gaps) && gaps.gaps.length) {
    lines.push(`known data gaps: ${gaps.gaps.length} 类`)
  }
  const lex = lexiconStatus()
  lines.push(`lexicon=${lex.source}${lex.terms ? ` (${lex.terms} 条)` : ''}`)
  return cut(lines.join('\n'), 3000)
}

// 插件启动后延迟预热（幂等、失败静默；重同步后最长 30 分钟自动重建）
setTimeout(() => { if (!stopped) warmupAliasMap().catch(() => {}) }, 5000).unref?.()
setTimeout(() => { if (!stopped) warmupLexicon().catch(() => {}) }, 8000).unref?.()
