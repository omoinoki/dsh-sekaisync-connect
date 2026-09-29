// dsh-sekaisync-connect —— 浏览器半侧：在「插件」面板的应用行配置页里选择 SekaiSync 部署路径。
//
// 参照官方 dsh-experimental-voice-input-bundle 的机制，但保持「零构建、纯 JS」：
//   - host 侧把面板后端做成 Typert Remote 服务（namespace `sekaisync`），
//     浏览器半侧不再手写 HTTP 路由/fetch，而是挂载一份手写的 TYPERT_REMOTE 贡献，
//     然后用 ctx.remote.sekaisync.<method>() 调用。
//   - 为什么可以手写 TYPERT_REMOTE 而不引入 zod：实测 0.2.0-rc.1 的 dsh-api-gateway
//     客户端只在贡献校验时检查每个参数 codec 的 mode === 'strict'（requireStrictInputs），
//     且 typert 注册表只要求 strict codec 带 typeSymbol 与一个 create() 工厂函数——
//     二者都**从不调用** create()/parse()（参数原样透传、result 原样透传）。因此这里给
//     每个参数一个 `{ mode:'strict', typeSymbol, create:()=>({parse:v=>v}) }` 占位即可。
//   - host 侧持久化走 settings.update（写 profile 的 cordis.patch.yml，官方正确位置）。
//
// 槽位：DSH 的「插件」页声明了 keyed 槽位 `plugins.row.config`，键为
// `<包名>#<行 id>`。注册它会让该行在插件页上多出一个「配置」控件，点开即是本页面。
// 注意 `<行 id>` 是 cordis.patch.yml 里那一行的 `id`（`sekaisync-connect`），
// **不是**包名——行 id 与包名刻意不同，见该文件的说明。
window.__ModuleLoader__.load({
  id: 'dsh-sekaisync-connect',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sekaisync'
    const PKG = 'dsh-sekaisync-connect'
    // 面板槽位键：`<包名>#<行 id>`，与 cordis.patch.yml 的 insert 行严格对应。
    const ROW_KEY = `${PKG}#sekaisync-connect`
    const NAMESPACE = 'sekaisync'

    /**
     * 手写的 Typert Remote 贡献：把 host 的 DeployService（namespace `sekaisync`）
     * 暴露成 ctx.remote.sekaisync.<method>()。参数按位置传递（host 侧 SRC 回退要求
     * 单一标识符形参），result 用 src-json（host 返回 plain object，网关原样透传）。
     */
    const codec = (symbol) => ({
      mode: 'strict',
      typeSymbol: symbol,
      create: () => ({ parse: (v) => v }),
    })
    const param = (name, symbol) => ({ name, wire: name, source: 'json', codec: codec(symbol) })
    const TYPERT_REMOTE = {
      package: PKG,
      descriptors: [
        { id: `${PKG}#${NAMESPACE}/state`, service: 'deploy', namespace: NAMESPACE, method: 'state', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' } },
        { id: `${PKG}#${NAMESPACE}/inspect`, service: 'deploy', namespace: NAMESPACE, method: 'inspect', invocation: { kind: 'direct' }, parameters: [param('path', `${PKG}#${NAMESPACE}/inspect:path`)], result: { mode: 'src-json' } },
        { id: `${PKG}#${NAMESPACE}/save`, service: 'deploy', namespace: NAMESPACE, method: 'save', invocation: { kind: 'direct' }, parameters: [param('store', `${PKG}#${NAMESPACE}/save:store`)], result: { mode: 'src-json' } },
        { id: `${PKG}#${NAMESPACE}/test`, service: 'deploy', namespace: NAMESPACE, method: 'test', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' } },
      ],
    }

    /** 面板自有的极简样式：只依赖主题变量；用 <style> 元素注入并在卸载时移除。 */
    function installStyles() {
      const tagId = 'dsh-sekaisync-connect/panel.css'
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-sekaisync-connect'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    const CSS = `
.sks-wrap{display:flex;flex-direction:column;gap:14px;max-width:760px}
.sks-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sks-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.sks-input{flex:1 1 320px;min-width:0;box-sizing:border-box;padding:7px 10px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.sks-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.sks-btn{padding:6px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.sks-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.sks-btn:disabled{opacity:.5;cursor:default}
/* 主按钮：填充 brand-primary，文字用 bg-base（即「底色」）。
   不要在填充色上写死 #fff —— 深色主题下 brand-primary 是亮色，
   白字会直接看不见。brand-primary 在两种主题里都是「画在 bg-base 上的强调色」，
   所以 bg-base 就是它在两种主题下都成立的对照字色。 */
.sks-btn-primary{background:var(--dsw-alias-brand-primary);
  border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.sks-btn-primary:hover:not(:disabled){filter:brightness(1.08)}
.sks-card{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:11px 13px;
  background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:7px}
.sks-kv{display:flex;gap:10px;font-size:12.5px;line-height:1.5}
.sks-k{color:var(--dsw-alias-label-secondary);flex:0 0 96px}
.sks-v{color:var(--dsw-alias-label-primary);word-break:break-all;font-family:ui-monospace,Consolas,monospace}
.sks-tag{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;line-height:1.6;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.sks-tag-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.sks-tag-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.sks-tag-err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sks-msg{font-size:12.5px;line-height:1.55;padding:8px 10px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.sks-msg-ok{color:var(--dsw-alias-state-success-primary)}
.sks-msg-err{color:var(--dsw-alias-state-error-primary)}
.sks-msg-warn{color:var(--dsw-alias-state-warn-primary)}
`

    /** 调用 host 的 Remote 方法。返回 {ok, value|error}。绝不抛到 React 渲染里。 */
    async function callRemote(remote, action, ...args) {
      try {
        const result = await remote[action](...args)
        if (result && result.ok) return { ok: true, value: result.value }
        return { ok: false, error: { message: (result && result.error && result.error.message) || String(action) } }
      } catch (e) {
        return { ok: false, error: { message: String((e && e.message) || e) } }
      }
    }

    const mono = (v) => h('span', { className: 'sks-v' }, v === null || v === undefined || v === '' ? '—' : String(v))

    function Kv(props) {
      return h('div', { className: 'sks-kv' }, [
        h('span', { className: 'sks-k', key: 'k' }, props.label),
        h('span', { className: 'sks-v', key: 'v', style: { flex: 1 } }, props.children),
      ])
    }

    function Message(props) {
      if (!props.text) return null
      return h('div', { className: `sks-msg sks-msg-${props.tone || 'warn'}` }, props.text)
    }

    function formatBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let i = 0
      let v = n
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
      return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
    }

    /**
     * 展示生效值 + 可用性复核。
     *
     * state 来自 host 的 state()（已保存生效的值）；preview 来自对输入框当前文本的
     * 实时 inspect。两者并存：preview 存在时用它显示「改完会变成什么」，
     * 并在值确实不同时标出「未保存」——否则用户改完路径到点保存之间毫无反馈。
     */
    function CurrentCard(props) {
      const { t, state, preview } = props
      if (!state) return null
      const pending = !!(preview && preview.ok && (preview.store !== state.store || preview.root !== state.root))
      const shown = preview && preview.ok ? preview : null
      const store = shown ? shown.store : state.store
      const root = shown ? shown.root : state.root
      const current = shown || state.current
      const tag = current && current.ok
        ? h('span', { className: 'sks-tag sks-tag-ok' }, t('storeOk'))
        : h('span', { className: 'sks-tag sks-tag-err' }, t('storeBad'))
      return h('div', { className: 'sks-card' }, [
        pending ? h('div', { key: 'p', className: 'sks-row' }, [
          h('span', { className: 'sks-tag sks-tag-warn' }, t('pendingSave')),
        ]) : null,
        h(Kv, { label: t('effectiveStore'), key: 's' }, [mono(store), ' ', tag]),
        h(Kv, { label: t('effectiveRoot'), key: 'r' }, mono(root)),
        h(Kv, { label: t('effectivePython'), key: 'p' }, mono(state.python)),
        current && current.message ? h('div', { className: 'sks-kv' }, [
          h('span', { className: 'sks-k', key: 'k' }, t('status')),
          h('span', { className: 'sks-v', key: 'v', style: { flex: 1, fontFamily: 'inherit' } }, current.message),
        ]) : null,
        state.resolveError ? h(Message, { tone: 'err', text: state.resolveError }) : null,
      ])
    }

    /**
     * 配置页本体。view='summary' 渲染一行摘要；view='page' 渲染完整表单（自带保存按钮）。
     *
     * 刻意只保留「输入路径 → 检查 → 保存并生效 → 测试连接」这一条链路：
     * 自动探测 / 选择文件夹 / 浏览目录这三个动作依赖宿主侧的目录级权限，
     * 在插件行的权限组合下并不可靠（native 选择器常常没挂载、全盘扫描又很慢），
     * 留着只会给用户三个按下去没反应的按钮。路径以文本输入为准。
     */
    function DeployPanel(props) {
      const { t, view, remote } = props
      const [state, setState] = React.useState(null)
      const [path, setPath] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [inspected, setInspected] = React.useState(null)

      const say = (tone, text) => setMessage({ tone, text })

      const refresh = React.useCallback(async () => {
        const result = await callRemote(remote, 'state')
        if (result.ok) {
          setState(result.value)
          setPath((current) => current || result.value.store || '')
        } else {
          say('err', result.error.message)
        }
      }, [remote])

      React.useEffect(() => { if (view === 'page') refresh() }, [view, refresh])

      // 「生效 store / 生效 root」必须随输入的路径实时变化，否则用户改完路径
      // 到保存之间看不到任何反馈。这里复用 inspect（host 侧同一个分类器），
      // 去抖 250ms 后只更新预览、不碰 message，避免打字时闪错误。
      const [preview, setPreview] = React.useState(null)
      React.useEffect(() => {
        if (view !== 'page') return undefined
        const typed = path.trim()
        if (!typed) { setPreview(null); return undefined }
        let cancelled = false
        const timer = setTimeout(async () => {
          const result = await callRemote(remote, 'inspect', typed)
          if (cancelled) return
          setPreview(result.ok ? result.value : null)
        }, 250)
        return () => { cancelled = true; clearTimeout(timer) }
      }, [path, view, remote])

      if (view === 'summary') {
        const store = state && state.store ? state.store : null
        return h('span', null, store ? t('summarySet', { path: store }) : t('summaryUnset'))
      }

      const run = (name, fn) => async () => {
        setBusy(name)
        setMessage(null)
        try { await fn() } finally { setBusy('') }
      }

      const doInspect = run('inspect', async () => {
        const result = await callRemote(remote, 'inspect', path)
        if (!result.ok) { setInspected(null); return say('err', result.error.message) }
        setInspected(result.value)
        say(result.value.ok ? 'ok' : 'err', result.value.message || (result.value.ok ? t('valid') : t('invalid')))
      })

      const doSave = run('save', async () => {
        const result = await callRemote(remote, 'save', path)
        if (!result.ok) return say('err', result.error.message)
        // host 侧 save 会把新值并回它自己的运行时快照，因此 state() 立刻返回新值；
        // 这里再主动 refresh 一次，让上方「生效值」卡片与保存同帧更新。
        await refresh()
        setPreview(null)
        say('ok', t('saved', { path: result.value.store }))
      })

      const doTest = run('test', async () => {
        const result = await callRemote(remote, 'test')
        if (!result.ok) return say('err', result.error.message)
        const v = result.value
        if (v.ok && v.healthy && v.ready) say('ok', t('testOk', { ms: v.elapsedMs, store: v.store }))
        else if (v.ok) say('warn', t('testUnready', { ms: v.elapsedMs }))
        else say('err', t('testFail', { error: v.error }))
      })

      return h('div', { className: 'sks-wrap' }, [
        h(CurrentCard, { key: 'cur', t, state, preview }),

        h('div', { key: 'input', className: 'sks-row' }, [
          h('input', {
            key: 'i',
            className: 'sks-input',
            value: path,
            spellCheck: false,
            placeholder: t('placeholder'),
            onChange: (e) => { setPath(e.target.value); setInspected(null) },
            onKeyDown: (e) => { if (e.key === 'Enter') doInspect() },
          }),
          h('button', { key: 'check', className: 'sks-btn', disabled: !!busy || !path, onClick: doInspect }, busy === 'inspect' ? t('working') : t('check')),
          h('button', { key: 'save', className: 'sks-btn sks-btn-primary', disabled: !!busy || !path, onClick: doSave }, busy === 'save' ? t('working') : t('save')),
        ]),

        h('div', { key: 'tools', className: 'sks-row' }, [
          h('button', { key: 'test', className: 'sks-btn', disabled: !!busy, onClick: doTest }, busy === 'test' ? t('testing') : t('test')),
        ]),

        inspected ? h('div', { key: 'insp', className: 'sks-card' }, [
          h(Kv, { key: 'k', label: t('kind') }, t('kind_' + String(inspected.kind || 'unknown').replace(/[^A-Za-z0-9]/g, '_'))),
          h(Kv, { key: 's', label: t('store') }, mono(inspected.store)),
          inspected.ok && inspected.databaseBytes
            ? h(Kv, { key: 'd', label: t('database') }, t('databaseSize', { size: formatBytes(inspected.databaseBytes), entries: inspected.kbEntries }))
            : null,
        ]) : null,

        h(Message, { key: 'msg', tone: message ? message.tone : 'warn', text: message ? message.text : '' }),

        h('div', { key: 'note', className: 'sks-label', style: { lineHeight: 1.6 } }, t('note')),
      ])
    }

    const ZH = {
      summarySet: '部署路径：{path}',
      summaryUnset: '尚未选择 SekaiSync 部署路径',
      effectiveStore: '生效 store',
      effectiveRoot: '生效 root',
      effectivePython: 'python',
      status: '可用性',
      storeOk: '已识别',
      storeBad: '不可用',
      placeholder: '输入 SekaiSync 仓库根或 store 目录的绝对路径',
      check: '检查',
      save: '保存并生效',
      pendingSave: '尚未保存',
      test: '测试连接',
      testing: '测试中…',
      working: '处理中…',
      kind: '识别为',
      kind_store: 'store 目录',
      kind_repo_root: '仓库根',
      kind_repo_root_empty_store: '仓库根（store 尚未生成）',
      kind_kb_dir: 'kb 目录',
      store: 'store',
      database: '数据库',
      databaseSize: '{size}，kb/ 下 {entries} 项',
      valid: '路径可用。',
      invalid: '路径不可用。',
      saved: '已保存并写入 profile 配置：{path}',
      testOk: '连接正常（{ms} ms）：{store}',
      testUnready: '服务已响应但尚未就绪（{ms} ms）。首次查询可能需要更长时间构建索引。',
      testFail: '连接失败：{error}',
      note: '保存会写入当前 profile 的 cordis.patch.yml（由 DSH 配置编辑器管理，升级不会被覆盖，写后即热加载）。只写 store / root 两个目录字段；python 是可执行文件路径，刻意不可在线编辑。',
    }

    const EN = {
      summarySet: 'Deployment: {path}',
      summaryUnset: 'No SekaiSync deployment path selected',
      effectiveStore: 'Effective store',
      effectiveRoot: 'Effective root',
      effectivePython: 'python',
      status: 'Availability',
      storeOk: 'recognized',
      storeBad: 'unusable',
      placeholder: 'Absolute path to the SekaiSync repo root or store directory',
      check: 'Check',
      save: 'Save and apply',
      pendingSave: 'Not saved yet',
      test: 'Test connection',
      testing: 'Testing…',
      working: 'Working…',
      kind: 'Recognized as',
      kind_store: 'store directory',
      kind_repo_root: 'repository root',
      kind_repo_root_empty_store: 'repository root (store not built yet)',
      kind_kb_dir: 'kb directory',
      store: 'store',
      database: 'Database',
      databaseSize: '{size}, {entries} entries under kb/',
      valid: 'Path is usable.',
      invalid: 'Path is not usable.',
      saved: 'Saved to the profile config: {path}',
      testOk: 'Connection healthy ({ms} ms): {store}',
      testUnready: 'The service answered but is not ready yet ({ms} ms). The first query may take longer while indexes build.',
      testFail: 'Connection failed: {error}',
      note: 'Saving writes the current profile\'s cordis.patch.yml (managed by the DSH config editor; survives upgrades, hot-applied). Only the store and root directory fields are editable; python is an executable path and deliberately not editable online.',
    }

    /**
     * 注册面板 UI。**必须在 `remote.sekaisync` 已进入 inject 的 fiber 里执行**：
     * 直接用 `ctx.remote.sekaisync` 会触发 cordis reflect 的
     * `cannot get property "sekaisync" without inject`。
     */
    function registerUi(ctx) {
      ctx.effect(() => installStyles(), 'dsh-sekaisync-connect: panel styles')
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-sekaisync-connect: dictionaries')
      const t = ctx.locale.bind(NS)

      // 官方约定（docs/subsystems/slots.md「Component inputs」）：
      // 「Components never receive ctx … services stay in the apply closure and are
      // projected into callbacks or observable sources.」
      // 因此这里把 ctx.remote.sekaisync.* 包成一组闭包，通过注册项的 inject 工厂
      // 交给组件——组件拿到的是普通函数，永远不接触 ctx。
      const remote = {
        state: () => ctx.remote.sekaisync.state(),
        inspect: (path) => ctx.remote.sekaisync.inspect(path),
        save: (store) => ctx.remote.sekaisync.save(store),
        test: () => ctx.remote.sekaisync.test(),
      }

      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_KEY,
        locale: NS,
        inject: () => ({ remote }),
      }, DeployPanel))
    }

    return {
      inject: ['remote', 'slots', 'locale'],
      /**
       * 两段式挂载（对齐官方 dsh-experimental-voice-input-bundle 的
       * `mountVoiceInput`）：先 `$mount` 贡献，再在一个把 `remote.<ns>` 纳入
       * inject 的子 fiber 里注册 UI。
       */
      async apply(ctx) {
        const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
        const ui = ctx.inject(['remote.sekaisync', 'slots', 'locale'], registerUi)
        try {
          await ui
        } catch (error) {
          await ui.dispose()
          await disposeRemote()
          throw error
        }
        return async () => {
          await ui.dispose()
          await disposeRemote()
        }
      },
    }
  },
})
