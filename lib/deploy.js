// dsh-sekaisync-connect —— SekaiSync 部署路径的**识别**（纯函数，无持久化、无目录遍历）。
//
// 持久化不落在这里：DSH 的官方做法是 Cordis Config（schemastery）+ Settings 服务
// （见 lib/config.js 与 lib/deploy-service.js）。Settings 把 .volatile() 字段写进
// profile 的 cordis.patch.yml，由 config-editor 管理（升级不覆盖、写后热加载）。
//
// 这里只保留「给定一个路径，它是不是一个 SekaiSync 部署」这一个纯判断。
// 曾经存在的自动探测（detectCandidates）与目录枚举（listDirectories）已删除：
// 它们只是面板上「自动探测 / 浏览目录」两个按钮的后端，而那两个按钮依赖宿主侧的
// 目录级权限，在插件行的权限组合下并不可靠；留着等于把不可达的文件系统遍历
// 长期挂在 Remote 面上。路径现在只由用户显式输入。
//
// 本文件不 import 任何 harness 包，便于离线单测。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
 * 判定用户给出的路径属于哪种形态，并给出可直接用于 store/root 的解。
 *
 * 接受四种输入（都会归一化为绝对路径）：
 *   - store 目录本身（含 kb/）
 *   - sekaisync 仓库根（含 store/kb/…）
 *   - kb/ 目录本身
 *   - 仓库根但 store 尚未建立（允许先配置，之后再生成）
 *
 * @param input - 用户输入的路径（面板文本框）。
 * @returns 分类结果；ok 为 true 时 store/root 已可直接写入配置。
 */
export function classifyPath(input) {
  const raw = String(input ?? '').trim().replace(/^"(.*)"$/, '$1')
  if (!raw) return { ok: false, reason: 'empty', message: '请输入一个目录。' }
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
        : '目录可用，但未找到 kb/sekaisync.db；首次查询时 sekaisync 可能需要重建索引。',
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
