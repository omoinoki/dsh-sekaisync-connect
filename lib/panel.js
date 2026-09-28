// dsh-sekaisync-connect —— 插件面板的 Host 端（HTTP 路由）。
//
// ── 为什么走 HTTP 路由，而不是 RPC ──────────────────────────────────
// DSH 中 bundle 的浏览器半侧**拿不到**到 host 半侧的私有 RPC：`host.call` /
// `harness.handle` 只属于动态 Cordis 代码插件（dsh-cordis-client-runner /
// -host-runner）。bundle 浏览器半侧只有浏览器全局（含 fetch），
// 而 dsh.client 的声明面只有 platform / inject / external / immediately。
// 因此 bundle 的既定做法就是「host 注册 HTTP 路由 + 浏览器 fetch」。
//
// ── 为什么用 connection.fetch 而不是 webServer.register ─────────────
// 面板会**写文件**，所以鉴权边界必须可靠。
//   - ctx.webServer.register 是裸 HTTP 路由，不附带任何信任校验。若直接用它，
//     要么自己手写 Host/Origin 判定（随附的 dsh-better-sidebar 就是这么做的），
//     要么只检查 remoteAddress——后者挡不住 DNS rebinding：恶意页面把域名解析到
//     127.0.0.1，请求的 remoteAddress 同样是回环，却带着跨站 Origin。
//   - ctx.connection.fetch.register 注册的精确路由挂在 `/api` 前缀下，而该前缀
//     由 dsh-client-connection 统一裁决：Host/Origin 信任栅栏（isTrustedApiRequest，
//     含 sec-fetch-site 与 Origin 比对）＋ 浏览器 cookie 鉴权。路径也由框架强制
//     必须落在 /api 内。
// 所以这里采用 connection.fetch.register：不重复造栅栏，且比 remoteAddress 检查更严。
// 这也意味着**不应**再自行判定 remoteAddress——那会破坏框架的 trustedHosts 支持。
// connection 由 dsh-web-app 组合包提供，与渲染本面板的 Web 组合同源；
// 没有它的组合（纯 CLI）根本不会渲染面板，因此不注册即可。
//
// ── 安全模型 ──────────────────────────────────────────────────────
//   1. 鉴权交给框架的 /api 栅栏（Host/Origin + cookie）。
//   2. 写操作只接受 store / root 两个字段，且必须通过 classifyPath()（现存、可识别的目录）。
//      刻意**不**接受 python —— 那等于把「任意程序执行」搬到网页上。
//   3. 只写插件自己的 config.local.json；目标由 getPluginRoot() 决定，不接受调用方指定。
import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { classifyPath, detectCandidates, inspectDeployment, writeLocalConfig } from './deploy.js'
import { call, ensureServer, getPluginRoot, getRuntimeConfig, loadConfig, reloadConfig, resolveStore } from './backend.js'

/**
 * 面板路由前缀。框架强制路由必须落在 `/api` 下，故用 `/api/sekaisync`。
 * 浏览器半侧使用**文档相对**地址 `api/sekaisync/<action>`，以便在应用的挂载点下解析。
 */
const BASE = '/api/sekaisync'
/** 浏览器半侧的文档相对前缀（去掉开头斜杠）。 */
const RELATIVE_BASE = BASE.slice(1)

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
const ok = (value) => json({ ok: true, value })
const fail = (status, code, message) => json({ ok: false, error: { code, message: String(message) } }, status)

/** 有界的目录列表（面板的「浏览」动作）。只列子目录，隐藏目录标记出来但不隐藏。 */
function listDirectories(input) {
  const target = resolve(String(input || getPluginRoot()))
  const stat = statSync(target) // 不存在/无权限 → 抛出，由上层转成 400
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

/** 当前部署状态：生效值、来源层、候选、可用性复核。 */
function buildState() {
  const pluginRoot = getPluginRoot()
  const cfg = loadConfig()
  let resolved = null
  let resolveError = null
  try { resolved = resolveStore(cfg) } catch (e) { resolveError = String(e.message || e) }
  return {
    ...inspectDeployment({ pluginRoot, runtime: getRuntimeConfig(), effective: cfg }),
    resolvedStore: resolved,
    resolveError,
    server: { externalPort: cfg.externalPort, maxResponseBytes: cfg.maxResponseBytes },
  }
}

/** 逐个动作的处理表。每个函数返回要交给 ok() 的值；抛错即 400。 */
const ACTIONS = {
  state: () => buildState(),

  detect: () => ({ candidates: detectCandidates({ pluginRoot: getPluginRoot() }) }),

  inspect: ({ path }) => classifyPath(path),

  browse: ({ path }) => listDirectories(path),

  /** 使用 DSH 的目录选择器（若本平台可用）；只有 native 才会弹系统对话框。 */
  pick: async (_body, ctx) => {
    const picker = ctx.get('directoryPicker')
    if (!picker || typeof picker.capability !== 'function') {
      return { available: false, reason: 'no-picker', message: '本组合未挂载目录选择器，请直接输入路径或使用浏览。' }
    }
    const capability = picker.capability()
    if (capability?.kind !== 'native') {
      return { available: false, reason: capability?.kind || 'unknown', message: '当前是浏览器内浏览模式，请使用「浏览」选择目录。' }
    }
    const chosen = await capability.pick()
    if (!chosen) return { available: true, cancelled: true }
    return { available: true, cancelled: false, path: chosen, inspected: classifyPath(chosen) }
  },

  /**
   * 保存：校验 → 只写 store/root → 重载后端。
   * 写入前必须通过 classifyPath（现存目录 + 可识别为 SekaiSync 部署），
   * 否则知识库会被指向一个必然失败的目录。
   */
  save: ({ store, root }) => {
    const pluginRoot = getPluginRoot()
    const inspected = classifyPath(store)
    if (!inspected.ok) throw new Error(`store 校验未通过：${inspected.message || inspected.reason}`)
    const patch = { store: inspected.store }
    // root 未指定时沿用分类结果（仓库根）——子进程需要它作为 cwd。
    if (root === undefined || root === null || root === '') {
      patch.root = inspected.root
    } else {
      const rootInfo = classifyPath(root)
      if (!rootInfo.ok) throw new Error(`root 校验未通过：${rootInfo.message || rootInfo.reason}`)
      patch.root = rootInfo.store === inspected.store ? rootInfo.root : rootInfo.path
    }
    const written = writeLocalConfig(pluginRoot, patch)
    const reload = reloadConfig()
    return {
      written,
      store: patch.store,
      root: patch.root,
      verified: inspected,
      reload: {
        before: { store: reload.before.store, root: reload.before.root },
        after: { store: reload.after.store, root: reload.after.root },
      },
    }
  },

  /** 试连：用当前生效配置真的打一次上游，把「选对了没有」变成可观察事实。 */
  test: async () => {
    const started = Date.now()
    try {
      const cfg = loadConfig()
      const store = resolveStore(cfg)
      // 注意：健康检查在 `/health`，**不是** `/api/v1/health`——后者不存在（实测 404）。
      // 用 call() 走 /api/v1/ 会把「连接正常」误报成失败；这里按 ensureServer()
      // 拿到的真实端口打根路径端点。
      const meta = await ensureServer()
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 60_000)
      let health
      try {
        const response = await fetch(`http://127.0.0.1:${meta.port}/health`, { signal: ctrl.signal, redirect: 'error' })
        health = await response.json()
      } finally { clearTimeout(timer) }
      // 再取一次最小端点，确认知识库真的能答（而不只是进程活着）。
      // call() 解出的是数据本身，不是 { data } 信封。
      let probe = null
      let probeError = null
      try {
        probe = await call('freshness', null, { timeoutMs: 60_000, noCache: true })
      } catch (e) { probeError = String(e.message || e) }
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        store,
        mode: meta.external ? 'external' : 'managed',
        healthy: !!(health && health.status === 'ok'),
        ready: !!(health && health.ready === true),
        upstream: health ?? null,
        freshness: probe,
        freshnessError: probeError,
      }
    } catch (e) {
      return { ok: false, elapsedMs: Date.now() - started, error: String(e.message || e) }
    }
  },
}

/**
 * 注册面板的精确 Fetch 路由。
 * 必须在 ctx.inject(['connection'], ...) 的子上下文里调用（路由挂在框架裁决的
 * 单个 `/api` 前缀下，路径也由框架强制必须落在该前缀内）。
 *
 * @param ctx - 携带 connection 的上下文。
 */
export function registerPanelRoutes(ctx) {
  const disposers = []
  for (const [action, run] of Object.entries(ACTIONS)) {
    const path = `${BASE}/${action}`
    disposers.push(ctx.connection.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          const text = await request.text()
          body = text.trim() === '' ? {} : JSON.parse(text)
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
        } catch (e) {
          return fail(400, 'bad-request', e.message)
        }
        try {
          return ok(await run(body, ctx))
        } catch (e) {
          return fail(400, 'action-failed', e.message)
        }
      },
    }))
  }
  return () => { for (const dispose of disposers) { try { dispose() } catch { /* 已卸载 */ } } }
}

export { BASE as PANEL_BASE, RELATIVE_BASE as PANEL_RELATIVE_BASE }
