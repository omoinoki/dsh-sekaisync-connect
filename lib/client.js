// dsh-sekaisync-connect —— 浏览器半侧：在「插件」面板的应用行配置页里选择 SekaiSync 部署路径。
//
// 形态说明：bundle 的浏览器半侧是**纯 JavaScript**，不能 import 模块，也不是 JSX。
// React 从模块表按名字取（baseline 表里有 React）；其余能力来自浏览器全局。
// 与 host 半侧通信走 HTTP：host 注册 /sekaisync/api/*（见 lib/panel.js），这里用 fetch。
// 这不是绕过框架——随附的 dsh-better-sidebar 用的就是同一套（/sidebar/api/*）。
//
// 槽位：DSH 的「插件」页声明了 keyed 槽位 `plugins.row.config`，键为
// `<包名>#<行 id>`。注册它会让该行在插件页上多出一个「配置」控件，点开即是本页面。
window.__ModuleLoader__.load({
  id: 'dsh-sekaisync-connect',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sekaisync'
    // 文档相对地址：应用可能挂在子路径下，绝对路径会失效。
    // 随附的 dsh-session-log-export 同样用 '/api/...'.slice(1) 的形式。
    const API = 'api/sekaisync'
    const ROW_KEY = 'dsh-sekaisync-connect#dsh-sekaisync-connect'

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
.sks-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
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
.sks-cands{display:flex;flex-direction:column;gap:5px;max-height:230px;overflow:auto}
.sks-cand{display:flex;gap:8px;align-items:center;justify-content:space-between;cursor:pointer;
  padding:6px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);font-size:12.5px}
.sks-cand:hover{border-color:var(--dsw-alias-brand-primary)}
.sks-cand-path{font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.sks-crumb{background:none;border:none;color:var(--dsw-alias-brand-primary);cursor:pointer;
  font:inherit;font-size:12.5px;padding:0}
.sks-dir{display:block;width:100%;text-align:left;background:none;border:none;cursor:pointer;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:3px 0}
.sks-dir:hover{color:var(--dsw-alias-brand-primary)}
.sks-hidden{opacity:.55}
`

    /**
     * 调用 host 的面板接口。返回 {ok, value|error}。
     * 任何网络/协议异常都收敛成结构化失败，绝不抛到 React 渲染里。
     */
    async function api(action, body) {
      try {
        const response = await fetch(`${API}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        const text = await response.text()
        let parsed
        try { parsed = JSON.parse(text) } catch {
          // 例如 401/403 由连接层直接返回纯文本
          return { ok: false, error: { message: `${action} 失败：HTTP ${response.status} ${text.slice(0, 120)}` } }
        }
        if (parsed && parsed.ok) return { ok: true, value: parsed.value }
        return { ok: false, error: (parsed && parsed.error) || { message: `HTTP ${response.status}` } }
      } catch (e) {
        return { ok: false, error: { message: String((e && e.message) || e) } }
      }
    }

    const mono = (v) => h('span', { className: 'sks-v' }, v === null || v === undefined || v === '' ? '—' : String(v))

    /** 把 'repo-root' / 'profile-row' 这类带连字符的标识转成字典键（点号命名不能带连字符）。 */
    const keyOf = (prefix, value) => prefix + String(value || 'unknown').replace(/[^A-Za-z0-9]/g, '_')

    /** 取字典项；缺失时回退到原始值，绝不把 undefined 渲染到界面上。 */
    const tr = (t, key, fallback) => {
      const value = t(key)
      return value === undefined || value === key ? (fallback === undefined ? String(key) : fallback) : value
    }

    /** 一行「键 : 值」，值可附带状态标签。 */
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

    /** 展示「当前生效值 + 来自哪一层」，让影子化（保存了但不生效）一眼可见。 */
    function CurrentCard(props) {
      const { t, state } = props
      if (!state) return null
      const store = state.fields.store
      const root = state.fields.root
      const current = state.current
      const tag = current && current.ok
        ? h('span', { className: 'sks-tag sks-tag-ok' }, t('storeOk'))
        : h('span', { className: 'sks-tag sks-tag-err' }, t('storeBad'))
      return h('div', { className: 'sks-card' }, [
        h(Kv, { label: t('effectiveStore'), key: 's' }, [mono(state.effective.store), ' ', tag]),
        h(Kv, { label: t('effectiveRoot'), key: 'r' }, mono(state.effective.root)),
        h(Kv, { label: t('source'), key: 'src' }, [
          h('span', { key: 'l' }, tr(t, keyOf('layer_', store.source), store.source)),
          store.shadowedBy
            ? h('span', { key: 'sh', className: 'sks-tag sks-tag-warn', style: { marginLeft: 8 } }, t('shadowed'))
            : null,
        ]),
        current && current.message ? h('div', { className: 'sks-kv' }, [
          h('span', { className: 'sks-k', key: 'k' }, t('status')),
          h('span', { className: 'sks-v', key: 'v', style: { flex: 1, fontFamily: 'inherit' } }, current.message),
        ]) : null,
        state.resolveError ? h(Message, { tone: 'err', text: state.resolveError }) : null,
      ])
    }

    /** 目录浏览：面包屑 + 子目录列表 + 「选择此目录」。 */
    function Browser(props) {
      const { t, listing, onNavigate, onChoose } = props
      if (!listing) return null
      return h('div', { className: 'sks-card' }, [
        h('div', { className: 'sks-row', key: 'crumbs' }, [
          ...listing.crumbs.map((crumb, index) => h('span', { key: crumb.path }, [
            index > 0 ? h('span', { key: 'sep', style: { opacity: 0.45 } }, ' / ') : null,
            h('button', { key: 'b', className: 'sks-crumb', onClick: () => onNavigate(crumb.path) }, crumb.name),
          ])),
        ]),
        h('div', { key: 'list', className: 'sks-cands' },
          listing.entries.length === 0
            ? [h('div', { key: 'empty', className: 'sks-label' }, t('noSubdirs'))]
            : listing.entries.map((entry) => h('button', {
              key: entry.path,
              className: entry.hidden ? 'sks-dir sks-hidden' : 'sks-dir',
              onClick: () => onNavigate(entry.path),
            }, '📁 ' + entry.name))),
        listing.truncated ? h(Message, { key: 'trunc', tone: 'warn', text: t('truncated') }) : null,
        h('div', { className: 'sks-row', key: 'actions' }, [
          h('button', { key: 'choose', className: 'sks-btn sks-btn-primary', onClick: () => onChoose(listing.path) }, t('chooseThis')),
        ]),
      ])
    }

    /**
     * 配置页本体。
     * @param props.view - 'summary' 只渲染一行摘要；'page' 渲染完整表单（自带保存按钮）。
     */
    function DeployPanel(props) {
      const { t, view } = props
      const [state, setState] = React.useState(null)
      const [path, setPath] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [candidates, setCandidates] = React.useState(null)
      const [listing, setListing] = React.useState(null)
      const [inspected, setInspected] = React.useState(null)

      const say = (tone, text) => setMessage({ tone, text })

      const refresh = React.useCallback(async () => {
        const result = await api('state')
        if (result.ok) {
          setState(result.value)
          setPath((current) => current || result.value.effective.store || '')
        } else {
          say('err', result.error.message)
        }
      }, [])

      React.useEffect(() => { if (view === 'page') refresh() }, [view, refresh])

      if (view === 'summary') {
        const store = state && state.effective ? state.effective.store : null
        return h('span', null, store ? t('summarySet', { path: store }) : t('summaryUnset'))
      }

      /** 包一层 busy 状态，避免重复点击。 */
      const run = (name, fn) => async () => {
        setBusy(name)
        setMessage(null)
        try { await fn() } finally { setBusy('') }
      }

      const doInspect = run('inspect', async () => {
        const result = await api('inspect', { path })
        if (!result.ok) { setInspected(null); return say('err', result.error.message) }
        setInspected(result.value)
        say(result.value.ok ? 'ok' : 'err', result.value.message || (result.value.ok ? t('valid') : t('invalid')))
      })

      const doDetect = run('detect', async () => {
        const result = await api('detect')
        if (!result.ok) return say('err', result.error.message)
        setCandidates(result.value.candidates || [])
        if (!result.value.candidates || result.value.candidates.length === 0) say('warn', t('noCandidates'))
      })

      const doBrowse = run('browse', async (startPath) => {
        const result = await api('browse', { path: startPath || path || undefined })
        if (!result.ok) return say('err', result.error.message)
        setListing(result.value)
      })

      const doPick = run('pick', async () => {
        const result = await api('pick')
        if (!result.ok) return say('err', result.error.message)
        if (!result.value.available) return say('warn', result.value.message || t('pickerUnavailable'))
        if (result.value.cancelled) return say('warn', t('pickerCancelled'))
        setPath(result.value.path)
        setInspected(result.value.inspected || null)
        setListing(null)
        say(result.value.inspected && result.value.inspected.ok ? 'ok' : 'warn',
          (result.value.inspected && result.value.inspected.message) || t('picked'))
      })

      const doSave = run('save', async () => {
        const result = await api('save', { store: path })
        if (!result.ok) return say('err', result.error.message)
        say('ok', t('saved', { path: result.value.store }))
        setCandidates(null)
        setListing(null)
        await refresh()
      })

      const doTest = run('test', async () => {
        const result = await api('test')
        if (!result.ok) return say('err', result.error.message)
        const v = result.value
        if (v.ok && v.healthy && v.ready) say('ok', t('testOk', { ms: v.elapsedMs, store: v.store }))
        else if (v.ok) say('warn', t('testUnready', { ms: v.elapsedMs }))
        else say('err', t('testFail', { error: v.error }))
      })

      return h('div', { className: 'sks-wrap' }, [
        h(CurrentCard, { key: 'cur', t, state }),

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
          h('button', { key: 'detect', className: 'sks-btn', disabled: !!busy, onClick: doDetect }, busy === 'detect' ? t('working') : t('autoDetect')),
          h('button', { key: 'pick', className: 'sks-btn', disabled: !!busy, onClick: doPick }, busy === 'pick' ? t('working') : t('chooseFolder')),
          h('button', { key: 'browse', className: 'sks-btn', disabled: !!busy, onClick: () => doBrowse(path) }, busy === 'browse' ? t('working') : t('browse')),
          h('button', { key: 'test', className: 'sks-btn', disabled: !!busy, onClick: doTest }, busy === 'test' ? t('testing') : t('test')),
        ]),

        inspected ? h('div', { key: 'insp', className: 'sks-card' }, [
          h(Kv, { key: 'k', label: t('kind') }, tr(t, keyOf('kind_', inspected.kind), inspected.kind)),
          h(Kv, { key: 's', label: t('store') }, mono(inspected.store)),
          inspected.ok && inspected.databaseBytes
            ? h(Kv, { key: 'd', label: t('database') }, t('databaseSize', { size: formatBytes(inspected.databaseBytes), entries: inspected.kbEntries }))
            : null,
        ]) : null,

        candidates ? h('div', { key: 'cands', className: 'sks-card' }, [
          h('div', { key: 'h', className: 'sks-label' }, t('candidates')),
          h('div', { key: 'l', className: 'sks-cands' }, candidates.length === 0
            ? [h('div', { key: 'e', className: 'sks-label' }, t('noneFound'))]
            : candidates.map((candidate) => h('div', {
              key: candidate.path,
              className: 'sks-cand',
              onClick: () => { setPath(candidate.path); setInspected(null); setCandidates(null) },
            }, [
              h('span', { key: 'p', className: 'sks-cand-path' }, candidate.path),
              h('span', { key: 'm', className: 'sks-label' }, [
                candidate.hasDatabase ? t('hasDb') : t('noDb'),
                ' · ',
                candidate.source,
              ]),
            ]))),
        ]) : null,

        listing ? h(Browser, {
          key: 'browser',
          t,
          listing,
          onNavigate: (next) => doBrowse(next),
          onChoose: (chosen) => { setPath(chosen); setListing(null); setInspected(null); say('warn', t('chosenHint')) },
        }) : null,

        h(Message, { key: 'msg', tone: message ? message.tone : 'warn', text: message ? message.text : '' }),

        h('div', { key: 'note', className: 'sks-label', style: { lineHeight: 1.6 } }, t('note')),
      ])
    }

    /** 面板只做展示，字节格式化与 host 侧保持同一套约定。 */
    function formatBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let i = 0
      let v = n
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
      return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
    }

    const ZH = {
      summarySet: ({ path }) => `部署路径：${path}`,
      summaryUnset: '尚未选择 SekaiSync 部署路径',
      effectiveStore: '生效 store',
      effectiveRoot: '生效 root',
      source: '来源',
      status: '可用性',
      storeOk: '已识别',
      storeBad: '不可用',
      shadowed: '被上层覆盖',
      layer_env: '环境变量',
      layer_profile_row: 'profile 行 config',
      layer_explicit_file: 'SEKAISYNC_CONFIG 文件',
      layer_local_file: 'config.local.json（本机）',
      layer_published_file: 'config.json（随包默认）',
      layer_default: '默认',
      placeholder: '输入 SekaiSync 仓库根或 store 目录的绝对路径',
      check: '检查',
      save: '保存并生效',
      autoDetect: '自动探测',
      chooseFolder: '选择文件夹…',
      browse: '浏览',
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
      databaseSize: ({ size, entries }) => `${size}，kb/ 下 ${entries} 项`,
      candidates: '探测到的候选部署',
      noneFound: '没有在常见位置找到 SekaiSync 部署，请手动选择。',
      hasDb: '含数据库',
      noDb: '无数据库',
      noSubdirs: '（无子目录）',
      truncated: '目录项过多，已截断显示。',
      chooseThis: '选择此目录',
      chosenHint: '已填入该目录，请点「检查」确认后再保存。',
      valid: '路径可用。',
      invalid: '路径不可用。',
      picked: '已选择。',
      pickerUnavailable: '本机不可用系统文件夹选择器，请在应用内浏览或直接输入路径。',
      pickerCancelled: '已取消选择。',
      saved: ({ path }) => `已保存并重新加载：${path}`,
      testOk: ({ ms, store }) => `连接正常（${ms} ms）：${store}`,
      testUnready: ({ ms }) => `服务已响应但尚未就绪（${ms} ms）。首次查询可能需要更长时间构建索引。`,
      testFail: ({ error }) => `连接失败：${error}`,
      note: '保存会写入插件目录的 config.local.json（本机专属覆盖，升级不会被覆盖）。环境变量与 profile 行 config 的优先级更高，若它们已设定 store，此处的修改不会生效。',
    }

    const EN = {
      summarySet: ({ path }) => `Deployment: ${path}`,
      summaryUnset: 'No SekaiSync deployment path selected',
      effectiveStore: 'Effective store',
      effectiveRoot: 'Effective root',
      source: 'Source',
      status: 'Availability',
      storeOk: 'recognized',
      storeBad: 'unusable',
      shadowed: 'overridden by a higher layer',
      layer_env: 'environment variable',
      layer_profile_row: 'profile row config',
      layer_explicit_file: 'SEKAISYNC_CONFIG file',
      layer_local_file: 'config.local.json (this machine)',
      layer_published_file: 'config.json (shipped default)',
      layer_default: 'default',
      placeholder: 'Absolute path to the SekaiSync repo root or store directory',
      check: 'Check',
      save: 'Save and apply',
      autoDetect: 'Auto-detect',
      chooseFolder: 'Choose folder…',
      browse: 'Browse',
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
      databaseSize: ({ size, entries }) => `${size}, ${entries} entries under kb/`,
      candidates: 'Detected candidate deployments',
      noneFound: 'No SekaiSync deployment found in the usual places; choose one manually.',
      hasDb: 'has database',
      noDb: 'no database',
      noSubdirs: '(no subdirectories)',
      truncated: 'Too many entries; the listing is truncated.',
      chooseThis: 'Choose this directory',
      chosenHint: 'Filled in. Press Check to confirm before saving.',
      valid: 'Path is usable.',
      invalid: 'Path is not usable.',
      picked: 'Selected.',
      pickerUnavailable: 'No native folder chooser on this host; browse in-app or type the path.',
      pickerCancelled: 'Selection cancelled.',
      saved: ({ path }) => `Saved and reloaded: ${path}`,
      testOk: ({ ms, store }) => `Connection healthy (${ms} ms): ${store}`,
      testUnready: ({ ms }) => `The service answered but is not ready yet (${ms} ms). The first query may take longer while indexes build.`,
      testFail: ({ error }) => `Connection failed: ${error}`,
      note: 'Saving writes config.local.json in the plugin directory (a machine-local override that survives upgrades). Environment variables and the profile row config take precedence, so a change here has no effect while either of those sets store.',
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-sekaisync-connect: dictionaries')
        // 注意：bundle 的浏览器半侧没有 dynamic-Cordis 的 `styles` 内置符号，
        // 只能自己插 <style>（随附的 dsh-better-sidebar 也是这么做的）。
        ctx.effect(() => installStyles(), 'dsh-sekaisync-connect: panel styles')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS,
        }, (props) => h(DeployPanel, { ...props, t: props.t || t })))
      },
    }
  },
})
