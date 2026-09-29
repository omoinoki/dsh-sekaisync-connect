// dsh-sekaisync-connect —— SekaiSync 部署路径的**识别与候选探测**（纯函数，无持久化）。
//
// 持久化不再落在这里：DSH 的官方做法是 Cordis Config（schemastery）+ Settings 服务
// （见 lib/config.js 与 lib/deploy-service.js）。Settings 把 .volatile() 字段写进
// profile 的 cordis.patch.yml，由 config-editor 管理（升级不覆盖、写后热加载）。
//
// 这里只保留与「路径是不是一个 SekaiSync 部署」有关的纯判断，以及面板浏览目录所需的
// 有界列表。这些函数不 import 任何 harness 包，便于离线单测。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

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
 *   - kb/ 目录本身
 *   - 仓库根但 store 尚未建立（允许先配置，之后再生成）
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
  // 若父目录里还有「像工作区容器」的子目录，再向下看一层。
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
    for (const candidate of [guess.path, join(guess.path, 'store')]) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const classified = classifyPath(candidate)
      if (!classified.ok) continue
      // 按解析出的 store 再去重一次：仓库根与它下面的 store/ 指向同一份部署。
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
  out.sort((a, b) => Number(b.hasDatabase) - Number(a.hasDatabase) || b.databaseBytes - a.databaseBytes)
  return out.slice(0, 12)
}

/**
 * 有界的目录列表（面板的「浏览」动作）。只列子目录。
 * 单独导出（而非嵌在 service 里）便于离线单测。
 */
export function listDirectories(input) {
  const target = resolve(String(input ?? homedir()))
  const stat = statSync(target) // 不存在/无权限 → 抛出，由调用方转成错误
  if (!stat.isDirectory()) throw new Error('不是目录：' + target)
  const entries = []
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try { isDir = statSync(join(target, entry.name)).isDirectory() } catch { isDir = false }
    }
    if (!isDir) continue
    entries.push({ name: entry.name, path: join(target, entry.name), hidden: entry.name.startsWith('.') })
  }
  entries.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name))
  const parent = dirname(target)
  const crumbs = []
  let cursor = target
  for (let i = 0; i < 24; i++) {
    crumbs.unshift({ name: cursor === sep ? cursor : basename(cursor) || cursor, path: cursor })
    const up = dirname(cursor)
    if (up === cursor) break
    cursor = up
  }
  return {
    path: target,
    parent: parent === target ? null : parent,
    crumbs,
    entries: entries.slice(0, 500),
    truncated: entries.length > 500,
  }
}
