// dsh-sekaisync-connect —— SekaiSync 部署路径的选择与持久化。
//
// 设计要点（为什么写 config.local.json，而不是 profile 的 cordis.patch.yml）：
//   1. 零依赖。config-editor 的 edit() 走 Loader/配置服务，需要本插件声明 Cordis
//      `Config`（含 schemastery import）。插件在 web profile 里是 link 到工作区的
//      包，解析不到 harness 内置包 → 会加载失败。见 backend.js 顶部注释。
//   2. config.local.json 本就是本插件既有的「机器专属覆盖」层（.gitignore 忽略），
//      已在 loadConfig() 的优先级链上，改动即刻生效、升级不被覆盖。
//   3. 升级语义清晰：config.json 是随包发布的默认值，config.local.json 是这台机器的
//      选择。面板只写后者。
//
// 安全边界（面板能改什么、不能改什么）：
//   面板**只允许**写 `store` 与 `root` 两个目录字段，且都必须是通过校验的现存目录。
//   刻意**不允许**改 `python`：那是一个可执行文件路径，把它暴露给 HTTP 路由等于把
//   「任意程序执行」放到了网页上。python 仍只由 config.json / SEKAISYNC_PYTHON 指定。
//   于是最坏情况只是把知识库指向另一个目录（查询失败），而不是执行任意代码。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'

/** store 里必须存在的相对路径（缺 kb/sekaisync.db 就不是可用的知识库）。 */
const STORE_DB = join('kb', 'sekaisync.db')
/** 判定为「sekaisync 仓库根」的标志（用于从仓库根反推 store）。 */
const REPO_MARKERS = [join('sekaisync', '__init__.py'), join('sekaisync', 'tools.py'), 'pyproject.toml']

function readJsonSafe(file) {
  try { return { value: JSON.parse(readFileSync(file, 'utf8')), error: null } }
  catch (e) {
    if (e && e.code === 'ENOENT') return { value: null, error: null }
    return { value: null, error: String(e.message || e) }
  }
}

function statSafe(path) {
  try { return statSync(path) } catch { return null }
}

function isDir(path) {
  const s = statSafe(path)
  return !!s && s.isDirectory()
}

/** 人类可读的字节数（面板展示用；不参与任何判定）。 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/**
 * 判定一个用户给出的路径属于哪种形态，并给出可直接用于 store/root 的解。
 *
 * 接受四种输入（都会归一化为绝对路径）：
 *   - store 目录本身（含 kb/sekaisync.db）
 *   - sekaisync 仓库根（含 store/kb/…）
 *   - store 的父目录 / 任意祖先（向下找一层 store/ 或 kb/）
 *   - 不存在或不合格的路径 → ok:false + 具体原因（面板据此提示，而不是静默失败）
 *
 * @param input - 用户输入的路径（面板文本框或目录选择器给出）。
 * @returns 分类结果；ok 为 true 时 store/root 已可直接写入配置。
 */
export function classifyPath(input) {
  const raw = String(input ?? '').trim().replace(/^"(.*)"$/, '$1')
  if (!raw) return { ok: false, reason: 'empty', message: '请输入或选择一个目录。' }
  if (!isAbsolute(raw)) {
    return { ok: false, reason: 'not-absolute', path: raw, message: '需要绝对路径（例如 C:\\dsh_projects\\sekaisync 或 /home/me/sekaisync）。' }
  }
  const abs = normalize(resolve(raw))
  const info = { path: abs, exists: existsSync(abs), isDir: isDir(abs), name: basename(abs) }
  if (!info.exists) return { ok: false, reason: 'not-found', ...info, message: '该路径不存在。' }
  if (!info.isDir) return { ok: false, reason: 'not-a-directory', ...info, message: '这是一个文件，请选择目录。' }

  const describe = (storePath, rootPath, kind) => {
    const db = join(storePath, STORE_DB)
    const dbStat = statSafe(db)
    const kbDir = join(storePath, 'kb')
    const kbCount = (() => {
      try { return readdirSync(kbDir).length } catch { return 0 }
    })()
    const freshness = readJsonSafe(join(storePath, 'kb', 'freshness.json')).value
    return {
      ok: true,
      kind,
      path: abs,
      store: storePath,
      root: rootPath,
      hasDatabase: !!dbStat,
      databaseBytes: dbStat ? dbStat.size : 0,
      databaseModified: dbStat ? dbStat.mtimeMs : null,
      kbEntries: kbCount,
      freshness: freshness && typeof freshness === 'object' ? freshness : null,
      message: dbStat
        ? `已识别为 SekaiSync 知识库（${formatBytes(dbStat.size)}）。`
        : `目录可用，但未找到 kb/sekaisync.db；首次查询时 sekaisync 可能需要重建索引。`,
    }
  }

  // 1) 输入本身就是 store
  if (isDir(join(abs, 'kb'))) return describe(abs, dirname(abs), 'store')
  // 2) 输入是仓库根（含 store/kb）
  if (isDir(join(abs, 'store', 'kb'))) return describe(join(abs, 'store'), abs, 'repo-root')
  // 3) 输入是 kb/ 目录本身
  if (basename(abs) === 'kb' && isDir(abs)) {
    const storePath = dirname(abs)
    return describe(storePath, dirname(storePath), 'kb-dir')
  }
  // 4) 仓库根但 store 尚未建立（允许先配置，之后再生成）
  const looksLikeRepo = REPO_MARKERS.some((marker) => existsSync(join(abs, marker)))
  if (looksLikeRepo) return describe(join(abs, 'store'), abs, 'repo-root-empty-store')

  return {
    ok: false,
    reason: 'no-store-found',
    ...info,
    message: '在该目录（及其 store/ 子目录）里没有找到 kb/，看起来不是 SekaiSync 部署。',
  }
}

/**
 * 在有限范围内寻找候选部署目录。刻意保持有界且不联网：
 * 只检查「当前生效值 / 环境变量 / 进程 cwd / 用户主目录下的常见名字 / 插件目录与 cwd
 * 的父目录里名字含 sekaisync 的兄弟目录」，且每个候选只向下看一层 `store/`。
 *
 * 注意：不写死 `C:\dsh_projects` 这类绝对路径——那在别的机器上既无效又像在偷看别人的盘。
 * 改为从实际运行环境推导（cwd 与 pluginRoot 的父目录）。
 *
 * @returns 去重后的候选列表，已按「有数据库、体积大」排序。
 */
export function detectCandidates({ pluginRoot, cwd = process.cwd(), env = process.env, extraRoots = [] } = {}) {
  const guesses = []
  const push = (path, source) => {
    if (!path) return
    const abs = normalize(resolve(String(path)))
    if (!guesses.some((g) => g.path === abs)) guesses.push({ path: abs, source })
  }

  push(env.SEKAISYNC_STORE, 'env:SEKAISYNC_STORE')
  push(env.SEKAISYNC_ROOT, 'env:SEKAISYNC_ROOT')
  push(cwd, 'process.cwd()')

  const home = homedir()
  for (const name of ['sekaisync', 'sekaisync-handoff', 'SekaiSync', 'sekaisync-store']) {
    push(join(home, name), 'home')
    push(join(home, 'projects', name), 'home/projects')
    push(join(home, 'Documents', name), 'home/Documents')
  }

  // 从 cwd / pluginRoot 的父目录扫描名字含 sekaisync 的兄弟目录。
  // 这正是本仓库的布局：<projects>/sekaisync-handoff-…/store 与 <projects>/dsh-sekaisync-connect。
  // 若父目录里还有「像工作区容器」的子目录（dsh_projects / projects / workspace / code…），
  // 再向下看一层——否则当 cwd 在别处时（例如从 DSH 安装目录启动）就找不到部署。
  const scanRoots = []
  const addScanRoot = (path, depth = 0) => {
    if (!path || depth > 1) return
    const abs = normalize(resolve(String(path)))
    if (!isDir(abs) || scanRoots.includes(abs)) return
    scanRoots.push(abs)
    if (depth === 0) {
      let entries
      try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (/sekaisync/i.test(entry.name)) continue // 它自己就是候选，不必再当容器扫
        if (/project|workspace|repo|src|code|dev/i.test(entry.name)) addScanRoot(join(abs, entry.name), depth + 1)
      }
    }
  }
  for (const base of [cwd, pluginRoot, ...extraRoots]) {
    if (base) addScanRoot(dirname(resolve(String(base))))
  }
  for (const base of scanRoots) {
    let entries
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { continue }
    let scanned = 0
    for (const entry of entries) {
      if (scanned >= 40) break // 有界：不把一个大目录整个走一遍
      if (!entry.isDirectory()) continue
      if (!/sekaisync/i.test(entry.name)) continue
      scanned++
      push(join(base, entry.name), 'sibling-scan')
    }
  }
  if (pluginRoot) push(dirname(pluginRoot), 'plugin-sibling')

  const seen = new Set()
  const out = []
  for (const guess of guesses) {
    // 每个候选尝试自身、以及「自身/store」两种形态。
    for (const candidate of [guess.path, join(guess.path, 'store')]) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const classified = classifyPath(candidate)
      if (!classified.ok) continue
      // 按**解析出的 store** 再去重一次：仓库根与它下面的 store/ 会指向同一份部署，
      // 面板里不该出现两条一样的。
      if (out.some((entry) => entry.path === classified.store)) continue
      out.push({
        path: classified.store,
        root: classified.root,
        kind: classified.kind,
        source: guess.source,
        hasDatabase: classified.hasDatabase,
        databaseBytes: classified.databaseBytes,
        databaseModified: classified.databaseModified,
        label: classified.store,
      })
    }
  }
  // 有数据库的排前面，其次体积大的（通常就是那份真库）。
  out.sort((a, b) => Number(b.hasDatabase) - Number(a.hasDatabase) || b.databaseBytes - a.databaseBytes)
  return out.slice(0, 12)
}

/**
 * 组装面板需要的完整状态：当前生效值、每个字段来自哪一层、以及是否被更高层遮蔽。
 *
 * 这条「来源」信息很重要：loadConfig() 的优先级是
 *   环境变量 > profile 行 config > SEKAISYNC_CONFIG 文件 > config.local.json > config.json > 自动发现
 * 因此当用户在 profile patch 或环境变量里钉死了 store 时，面板写入 config.local.json
 * 会被影子化（看起来「保存成功但不生效」）。这里如实识别并回报，让面板给出准确提示。
 */
export function inspectDeployment({ pluginRoot, runtime = null, env = process.env, cwd = process.cwd(), effective = null, discovered = null } = {}) {
  const published = readJsonSafe(join(pluginRoot, 'config.json'))
  const local = readJsonSafe(join(pluginRoot, 'config.local.json'))
  const explicitPath = env.SEKAISYNC_CONFIG ? String(env.SEKAISYNC_CONFIG) : null
  const explicit = explicitPath ? readJsonSafe(explicitPath) : { value: null, error: null }

  const trim = (v) => (v === undefined || v === null || v === '' ? null : v)
  const fields = {}
  for (const field of ['store', 'root', 'python', 'externalPort']) {
    const envKey = `SEKAISYNC_${field === 'externalPort' ? 'PORT' : field.toUpperCase()}`
    const layers = [
      ['env', trim(env[envKey]), envKey],
      ['profile-row', trim(runtime?.[field]), 'cordis.patch.yml 的 config'],
      ['explicit-file', trim(explicit.value?.[field]), explicitPath],
      ['local-file', trim(local.value?.[field]), join(pluginRoot, 'config.local.json')],
      ['published-file', trim(published.value?.[field]), join(pluginRoot, 'config.json')],
    ]
    const winner = layers.find(([, value]) => value !== null)
    fields[field] = {
      value: effective?.[field] ?? winner?.[1] ?? null,
      source: winner ? winner[0] : 'default',
      detail: winner ? winner[2] : null,
      // 面板只能改 config.local.json；若更上层已设定该字段，写入不会生效。
      shadowedBy: winner && winner[0] !== 'local-file' && winner[0] !== 'published-file' && winner[0] !== 'default'
        ? winner[0] : null,
    }
  }

  const localError = local.error
  const explicitError = explicit.error

  return {
    pluginRoot,
    configFiles: {
      published: { path: join(pluginRoot, 'config.json'), values: published.value, error: published.error },
      local: { path: join(pluginRoot, 'config.local.json'), values: local.value, error: localError },
      explicit: explicitPath ? { path: explicitPath, values: explicit.value, error: explicitError } : null,
    },
    fields,
    effective: {
      store: fields.store.value,
      root: fields.root.value,
      python: fields.python.value,
      externalPort: fields.externalPort.value,
    },
    // 当前生效的 store 是否真的可用（文件系统层面复核）。
    current: effective?.store ? classifyPath(effective.store) : null,
    // 自动发现的结果（可能为 null；面板提供「重新自动探测」动作）。
    discovery: discovered,
    candidates: detectCandidates({ pluginRoot, cwd, env }),
    writable: { store: !fields.store.shadowedBy, root: !fields.root.shadowedBy },
  }
}

/**
 * 原子写入 config.local.json，只覆盖给定的字段，保留文件里其它键（如 python、externalPort）。
 * 写入前先同目录临时文件再 rename，避免半写状态被并发的 loadConfig() 读到。
 *
 * @returns 写入后的完整对象。
 */
export function writeLocalConfig(pluginRoot, patch) {
  const file = join(pluginRoot, 'config.local.json')
  const existing = readJsonSafe(file)
  if (existing.error) throw new Error(`config.local.json 解析失败，拒绝覆盖：${existing.error}`)
  const next = { ...(existing.value && typeof existing.value === 'object' ? existing.value : {}) }
  for (const [key, value] of Object.entries(patch || {})) {
    if (!['store', 'root'].includes(key)) throw new Error(`不允许写入字段：${key}`)
    if (value === null || value === undefined || value === '') delete next[key]
    else next[key] = value
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 清理失败无关紧要 */ }
    throw e
  }
  return next
}
