// 复刻 0.1.7-rc.2 的 readPluginMeta(specifier, parentURL)（app-boot/lib/index.js:1969）
// 以验证本插件在新版「插件入口」（plugin_manager 工具 + Web Plugins 页 +
// Settings 只读插件清单）里能否正确呈现：locale/en.json、locale/zh.json、
// package.json（title/description/icon 回退）。走真实的 Node 解析器与 profile 基址。
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const SPECIFIER = 'dsh-sekaisync-connect'
// profile 的解析基址：profile 目录本身（DSH 用 Loader tree 的 baseUrl）
const PARENT = pathToFileURL('C:\\Users\\Mutou\\.dsh\\profiles\\web\\').href

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
const req = createRequire(PARENT + '_')
function resolvePluginResource(spec) {
  return req.resolve(spec)
}
function optionalResourcePath(spec) {
  try { return resolvePluginResource(spec) } catch (e) {
    const c = e?.code
    if (c === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || c === 'ERR_MODULE_NOT_FOUND' || c === 'MODULE_NOT_FOUND' || c === 'ENOENT' || c === 'ENOTDIR') return undefined
    throw e
  }
}
function readObject(f) { return JSON.parse(readFileSync(f, 'utf8')) }
function textOf(v, p) { if (v === undefined) return undefined; if (typeof v !== 'string' || v.trim() === '') throw new Error(`${p} must be a non-empty string`); return v }
function objectOf(v, p) { if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${p} must be an object`); return v }
function fallbackText(v) { return typeof v === 'string' && v.trim() !== '' ? v : undefined }

const englishPath = optionalResourcePath(`${SPECIFIER}/locale/en.json`)
console.log('resolve locale/en.json ->', englishPath ?? '(NOT RESOLVED)')
const dictionaries = new Map()
if (englishPath) {
  for (const entry of readdirSync(dirname(englishPath), { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    const resource = `${SPECIFIER}/locale/${entry.name}`
    const language = entry.name.slice(0, -5)
    if (!LANGUAGE_ID.test(language)) { console.log('  INVALID language id: ' + resource); continue }
    const id = language.toLowerCase()
    if (dictionaries.has(id)) { console.log('  DUPLICATE locale: ' + id); continue }
    const file = resolvePluginResource(resource)
    if (dirname(file) !== dirname(englishPath)) { console.log('  MISPLACED locale file: ' + file); continue }
    const parsed = readObject(file)
    const meta = parsed.meta === undefined ? undefined : objectOf(parsed.meta, `${file}: meta`)
    dictionaries.set(id, { title: textOf(meta?.title, `${file}: meta.title`), description: textOf(meta?.description, `${file}: meta.description`) })
    console.log(`  locale ${id}: title=${JSON.stringify(meta?.title)} desc=${meta?.description ? 'yes' : 'no'}`)
  }
}

const manifestPath = optionalResourcePath(`${SPECIFIER}/package.json`)
console.log('resolve package.json   ->', manifestPath ?? '(NOT RESOLVED)')
const manifest = manifestPath ? readObject(manifestPath) : undefined

// ── 图标（复刻 app-boot:iconOf）────────────────────────────────────────
// 0.1.7-rc.2 的新插件入口会读 package.json 的顶层 icon，规则严格：
// 必须 manifest 相对路径、扩展名限 SVG/PNG/JPEG/WebP、≤256 KiB、realpath 后仍在包内。
const MAX_ICON_BYTES = 256 * 1024
const ICON_MEDIA_TYPES = new Map([['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']])
let iconResult
try {
  const icon = textOf(manifest?.icon, `${manifestPath}: icon`)
  if (icon === undefined) iconResult = { state: 'absent' }
  else {
    if (isAbsolute(icon) || win32.isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) throw new Error('icon must be a relative file path')
    const mediaType = ICON_MEDIA_TYPES.get(extname(icon).toLowerCase())
    if (mediaType === undefined) throw new Error('icon must be SVG, PNG, JPEG, or WebP')
    const directory = realpathSync(dirname(manifestPath))
    const file = realpathSync(resolve(directory, icon))
    const local = relative(directory, file)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('icon must remain inside its manifest directory')
    const stat = statSync(file)
    if (!stat.isFile()) throw new Error('icon must be a regular file')
    if (stat.size > MAX_ICON_BYTES) throw new Error('icon exceeds 256 KiB')
    const bytes = readFileSync(file)
    if (bytes.length > MAX_ICON_BYTES) throw new Error('icon exceeds 256 KiB')
    iconResult = { state: 'ok', mediaType, bytes: bytes.length, dataUrl: `data:${mediaType};base64,…` }
  }
} catch (e) { iconResult = { state: 'error', error: e.message } }
console.log('icon                   ->', JSON.stringify(iconResult))

function localizedText(field, fallback, finalFallback) {
  const entries = [...dictionaries].flatMap(([lang, fields]) => fields[field] === undefined ? [] : [[lang, fields[field]]])
  if (entries.length === 0) return fallback
  return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) }
}
const title = localizedText('title', fallbackText(manifest?.name), SPECIFIER)
const description = localizedText('description', fallbackText(manifest?.description), '')
console.log('\n--- readPluginMeta() result ---')
console.log('title      =', JSON.stringify(title))
console.log('description=', JSON.stringify(description))

console.log('\n--- manifest fields the new entry point reads / enforces ---')
console.log('dsh.manifestVersion =', manifest?.dsh?.manifestVersion)
console.log('dsh.bundle.patch    =', manifest?.dsh?.bundle?.patch)
console.log('engines.dsh         =', manifest?.engines?.dsh ?? '(未声明)')
console.log('peerDependencies    =', JSON.stringify(manifest?.peerDependencies ?? null))
console.log('exports keys        =', JSON.stringify(Object.keys(manifest?.exports ?? {})))
// 顶层 meta 不被任何代码读取：readPluginMeta 只从 locale/*.json 取 meta。
console.log('package.json meta   =', manifest?.meta === undefined ? '(未声明，正确——该字段不会被读取)' : '(存在但不会被读取)')

const ok = englishPath !== undefined && manifestPath !== undefined
  && typeof title === 'object' && title.en === 'SekaiSync Connect'
  && typeof description === 'object' && !!description.zh
  && iconResult.state === 'ok'
  && manifest?.meta === undefined
console.log(ok ? '\nPLUGIN ENTRY METADATA OK (localized title+description+icon resolve)' : '\nPLUGIN ENTRY METADATA PROBLEM')
process.exit(ok ? 0 : 1)
