// dsh-sekaisync-connect — SekaiSync 知识库的 DeepSeek Harness 直连模块。
// 零依赖、零构建：不引入 MCP 协议栈/向量库/Node SDK，直连 sekaisync 自带的
// HTTP 服务（插件负责拉起子进程），结果在插件侧压缩后进入模型上下文。
//
// 3.x 对齐 DeepSeek Harness V0.1.7-rc.2：
//   - 协作式取消：每个工具体都接收并观测 exec.signal（取消立即中止 fetch）。
//   - isConcurrencySafe：按实测成本把只读查询分为可并行/独占两类。
//   - timeoutMs 仅为「声明」：DSH 由 dsh-tool-call-timeout-policy 在 tools/execute
//     上真正执行，因此外层预算必须严格大于插件内层 fetch 预算（见 audit-timeouts）。
// 刻意不使用 deferLoading：该标记要求消费方按历史回放补发定义，
// 且 @deepseek-ai/dsh-llm-pi-ai 遇到它会直接报 UNSUPPORTED_CONTENT。
import {
  call, dispose, status, resolveAlias, resolveWithFallback, looksLikeAliasQuery,
  compactLookup, compactFact, compactResolve, compactTerm, compactPenetrate,
  compactAlias, compactWl, compactWeb, compactStatus, compactNews,
  probeSekai, compactProbe, lexiconStatus, setRuntimeConfig,
} from './backend.js'
import { Config } from './config.js'
import { DeployService } from './deploy-service.js'

export const name = 'dsh-sekaisync-connect'
export const inject = ['tools']
export { Config }

// 活动解析结果按 kind 选择压缩器（wl → World Link，box → 箱活）
const compactActivity = (data) => (data && data.kind === 'wl' ? compactWl(data) : compactAlias(data))

// 属性级 JSON Schema 构造器。required 统一放在工具 schema 的根 required 数组，
// 属性内不再带 required 标志（非标准 JSON Schema 用法）。
const str = (description) => ({ type: 'string', description })
const int = (description, def) => ({ type: 'integer', default: def, description })
const enumStr = (description, values, def) => ({
  type: 'string',
  ...(def ? { default: def } : {}),
  enum: values,
  description,
})

// 工具参数必须包装为完整 JSON Schema：根 type 必须为 'object'。
// dsh 会把 parameters 直接作为 JSON Schema 校验，裸属性映射会导致
// "schema must be a JSON Schema of 'type: object', got 'type: null'"。
const object = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
})

// 语言枚举：与 store v3 的译名槽键一致。
const LANGS = ['ja', 'en', 'zh_hans', 'zh_hant', 'ko']

// ── 参数守卫 ──────────────────────────────────────────────────────────
// DSH 的原始 `ctx.tools.register()` 路径**不会**在执行前校验 arguments：
// 校验由 `defineTool()` 编译进工具体，而本插件无法 import @deepseek-ai/dsh-tools
// （profile 外部的 link 包解析不到 harness 内置包）。因此 schema 里的 required
// 对模型只是「声明」，真正的拦截落在上游 HTTP 层（返回 400）。
// 这里补一层插件侧守卫，把「缺参」变成一条自解释的消息，并省掉一次必然失败的
// HTTP 往返（也少占一个服务槽位）：
const REQUIRED = {
  sekai_probe: ['query'],
  sekai_lookup: ['query'],
  sekai_fact: ['entity_id'],
  sekai_resolve: ['query'],
  sekai_term: ['query'],
  sekai_penetrate: ['query'],
  sekai_alias: ['query'],
  sekai_web: ['query'],
}

function missingArgs(name, args) {
  const need = REQUIRED[name]
  if (!need) return null
  const missing = need.filter((k) => {
    const v = args?.[k]
    return v === undefined || v === null || String(v).trim() === ''
  })
  return missing.length ? missing : null
}

// ── 超时预算 ──────────────────────────────────────────────────────────
// 外层 = DSH 的 timeoutMs（由 dsh-tool-call-timeout-policy 执行），
// 内层 = 插件 fetch 的 abort 预算。外层恒比内层多 10s，好让插件自己的
// 「ERROR: … 超时」先返回，而不是被 DSH 的通用 tool-timeout 抢先掐掉。
//
// 取值依据（0.4.0-alpha 修复后 / 本机 store 实测，见 VERIFY-0.4.0-alpha.md §八）：
//   health 35ms · lookup 2.4s · fact_pack 5ms · freshness 7ms · term_lookup 195ms
//   resolve 1.3s · news 92ms · activity 1.3s · status 6s(暖)/33s(冷)
//   term_penetrate 43–99s · web_lookup 121–142s
// 预算按「实测 + 余量」给，同时覆盖首次调用要付的子进程冷启（START_TIMEOUT_MS=120s）。
const BUDGET = {
  lookup: { outer: 150_000, inner: 140_000 },
  fact: { outer: 120_000, inner: 110_000 },
  resolve: { outer: 120_000, inner: 110_000 },
  term: { outer: 120_000, inner: 110_000 },
  penetrate: { outer: 200_000, inner: 190_000 },
  alias: { outer: 150_000, inner: 140_000 },
  web: { outer: 260_000, inner: 250_000 },
  news: { outer: 120_000, inner: 110_000 },
  status: { outer: 180_000, inner: 170_000 },
}

// 每个工具：描述 ≤ 40 字；execute 永远返回字符串（成功=压缩结果，失败=ERROR: 原因）。
// execute(a, exec) 里的 exec.signal 是调用方拥有的取消信号（Harness 0.1.7 契约）。
const TOOLS = [
  {
    name: 'sekai_probe',
    description: '轻量判定查询内容是否为《世界计划》(Project Sekai) 相关内容——不确定话题/陌生名词/来源不明的角色名时，先探测再决定是否走 sekai_* 工具。返回 verdict=yes|maybe|no、命中词及其 tag/weight 与建议的下一个工具。',
    timeoutMs: 3_000,
    // 纯本地词库打分，不发 HTTP、不占服务槽位，可安全并行。
    isConcurrencySafe: () => true,
    parameters: object({
      query: str('待判定内容（问题/名词/文本片段）'),
    }, ['query']),
    async execute(a) {
      return compactProbe(probeSekai(a.query))
    },
  },
  {
    name: 'sekai_lookup',
    description: '查询本地《世界计划》知识库实体（可玩角色/活动/卡片/卡池/曲目/区域；剧情配角|NPC 不在档案库，请用 sekai_web 搜剧情全文），任意语言名称匹配，返回跨服名称与关键事实。查询含活动简称（khn3、wl3）或官方箱活名时自动附带活动解析。',
    timeoutMs: BUDGET.lookup.outer,
    // 实测 2.4s，但仍会触碰 SQL registry 快照，与重查询并行会争用服务槽位。
    isConcurrencySafe: () => false,
    parameters: object({
      query: str('查询词（任意语言）'),
      type: str('实体类型过滤，如 character/card/event/music'),
      region: enumStr('区域过滤', ['jp', 'en', 'tc', 'kr', 'cn']),
      language: enumStr('语言', LANGS),
      limit: int('条数上限（≤100）', 8),
    }, ['query']),
    async execute(a, exec) {
      try {
        const deadline = Date.now() + BUDGET.lookup.inner
        const data = await call('lookup', {
          query: a.query, type: a.type, region: a.region, language: a.language, limit: a.limit ?? 8,
        }, { timeoutMs: BUDGET.lookup.inner, signal: exec?.signal })
        const hits = (data && data.results) || []
        const probeAlias = hits.length === 0 || hits.some((r) => r.type === 'event') || looksLikeAliasQuery(a.query)
        const remaining = deadline - Date.now()
        const alias = probeAlias && remaining > 0
          ? await resolveAlias(a.query, a.region, Math.min(15_000, remaining), exec?.signal).catch((e) => {
            if (exec?.signal?.aborted) throw e
            return null // Optional enrichment must preserve completed lookup facts.
          }) : null
        if (!hits.length && alias) return '[活动解析] ' + compactActivity(alias)
        let out = compactLookup(data)
        if (alias) out += '\n\n[活动解析] ' + compactActivity(alias)
        return out
      } catch (e) { return `ERROR: ${e.message}` }
    },
  },
  {
    name: 'sekai_fact',
    description: '按实体 id 返回紧凑事实包（如 character:1、card:123）。生成内容前取结构化事实的最省方式，自带 token 压缩统计。',
    timeoutMs: BUDGET.fact.outer,
    isConcurrencySafe: () => true, // 实测 5ms 的只读快照查询
    // 注意：HTTP 的 /api/v1/fact_pack 只声明 entity_id + language（P15 参数面），
    // core.fact_pack 的 region/as_of 是仅走「as-of 事实包」时才需要的参数，未开放到
    // HTTP。透出它们会被上游 coerce_args 静默忽略，让模型以为做了区服过滤——故不暴露。
    parameters: object({
      entity_id: str('实体 id（先用 sekai_lookup 确认）'),
      language: enumStr('事实包语言', LANGS, 'en'),
    }, ['entity_id']),
    async execute(a, exec) {
      try {
        const pack = await call('fact_pack', {
          entity_id: a.entity_id, language: a.language ?? 'en',
        }, { timeoutMs: BUDGET.fact.inner, signal: exec?.signal })
        return compactFact(pack)
      } catch (e) { return `ERROR: ${e.message}` }
    },
  },
  {
    name: 'sekai_resolve',
    description: '把专有名词解析为官方本地化名称（官方词表翻译记忆），如 Ichika → 星乃一歌。返回 translation_status，未覆盖的译名如实标注而非留空。',
    timeoutMs: BUDGET.resolve.outer,
    isConcurrencySafe: () => true, // 实测 1.3s 的只读词表查询
    parameters: object({
      query: str('待解析名词'),
      target_language: enumStr('目标语言', LANGS, 'zh_hant'),
      source_language: enumStr('源语言，缺省自动', LANGS),
      kind: str('类别过滤，如 character/music/area'),
    }, ['query']),
    async execute(a, exec) {
      try {
        const data = await resolveWithFallback({
          query: a.query, target_language: a.target_language ?? 'zh_hant',
          source_language: a.source_language, kind: a.kind,
        }, { timeoutMs: BUDGET.resolve.inner, signal: exec?.signal })
        return compactResolve(data)
      } catch (e) { return `ERROR: ${e.message}` }
    },
  },
  {
    name: 'sekai_term',
    description: '查询游戏内用语及跨语言译名（如 ネットパラダイス → 网络天堂 / NetParadise），含 tags（person/event/product/location/organization/other）、weight 与出处证据句。可按 tag 与 weight 排序过滤。',
    timeoutMs: BUDGET.term.outer,
    isConcurrencySafe: () => true, // 实测 195ms
    parameters: object({
      query: str('用语（任意语言）'),
      language: enumStr('源语言，缺省全语言匹配', LANGS),
      tag: enumStr('标签过滤', ['person', 'location', 'organization', 'event', 'product', 'other']),
      sort: enumStr('排序：score=匹配分 / weight=语料权重', ['score', 'weight'], 'score'),
      limit: int('条数上限（≤100）', 8),
    }, ['query']),
    async execute(a, exec) {
      try {
        const data = await call('term_lookup', {
          query: a.query, language: a.language, tag: a.tag,
          sort: a.sort ?? 'score', limit: a.limit ?? 8,
        }, { timeoutMs: BUDGET.term.inner, signal: exec?.signal })
        return compactTerm(data)
      } catch (e) { return `ERROR: ${e.message}` }
    },
  },
  {
    name: 'sekai_penetrate',
    description: '用语跨语言穿透：取同一剧情点位下各语言的对应词与原文句（含 trust）。用于核对译名在具体语境中的实际用词，或确认某语言是否真的没有对应行。慢（约 1 分钟）。',
    timeoutMs: BUDGET.penetrate.outer,
    isConcurrencySafe: () => false, // 实测 43–99s，独占以免占满服务槽位
    parameters: object({
      query: str('用语（任意语言，先用 sekai_term 确证存在）'),
      story_key: str('指定点位，如 event:174:1；缺省自动选证据最集中的已发布点位'),
      languages: str('语言列表，逗号分隔（默认 ja,zh_hans,en）'),
    }, ['query']),
    async execute(a, exec) {
      try {
        const data = await call('term_penetrate', {
          query: a.query, story_key: a.story_key, languages: a.languages ?? 'ja,zh_hans,en',
        }, { timeoutMs: BUDGET.penetrate.inner, signal: exec?.signal })
        return compactPenetrate(data)
      } catch (e) { return `ERROR: ${e.message}` }
    },
  },
  {
    name: 'sekai_alias',
    description: '解析活动简称（箱活 khn3/豆三箱/心羽3；World Link wl3/25wl/lnwl/vbs wl2/finale/round2/wl3gN）与官方箱活名（各服官方名均可，如「雨过天晴的启明星」）为官方活动，支持自然问句自动提取简称，含跨服名称、日期、曲目与卡片。',
    // resolveAlias 内部含活动索引构建（冷启可达 ~1.8s）+ /activity 调用。
    timeoutMs: BUDGET.alias.outer,
    isConcurrencySafe: () => false,
    parameters: object({
      query: str('简称或含简称的问句，如 khn3 / wl3'),
      regions: str('区域列表，逗号分隔（jp/en/tc/kr/cn）'),
    }, ['query']),
    async execute(a, exec) {
      try {
        const data = await resolveAlias(a.query, a.regions, BUDGET.alias.inner, exec?.signal)
        return compactActivity(data)
      } catch (e) { return `ERROR: ${e.message}` }
    },
  },
  {
    name: 'sekai_web',
    description: '搜索本地已爬取的剧情全文（Sekai Viewer / Moesekai），用于引用、剧情梗概与主数据库外的文本。慢（约 1–2 分钟）。include_text 可索取正文片段。',
    // 实测 121–142s；外层留 10s 余量。
    timeoutMs: BUDGET.web.outer,
    isConcurrencySafe: () => false,
    parameters: object({
      query: str('查询词'),
      language: enumStr('语言', LANGS),
      source: enumStr('站点', ['altsource_sv', 'altsource_ms']),
      kind: str('类别过滤，如 event_story/card_story/area_dialogue'),
      limit: int('条数上限（≤100）', 5),
      include_text: { type: 'boolean', default: false, description: 'true 时附带正文片段（上游仍在收窄后取正文，成本可控）' },
      max_text_chars: int('include_text 时的正文上限字符数（≤200000）', 1200),
    }, ['query']),
    async execute(a, exec) {
      try {
        const includeText = a.include_text === true
        const data = await call('web_lookup', {
          query: a.query, language: a.language, source: a.source, kind: a.kind,
          limit: a.limit ?? 5,
          include_text: includeText ? true : undefined,
          max_text_chars: includeText ? (a.max_text_chars ?? 1200) : undefined,
        }, { timeoutMs: BUDGET.web.inner, signal: exec?.signal })
        return compactWeb(data)
      } catch (e) { return `ERROR: ${e.message}` }
    },
  },
  {
    name: 'sekai_news',
    description: '查询五服官方公告（ja/en/tc/kr/cn，2千+条，含正文缓存标记）。回答「最近有什么活动/公告/维护」前先查。按语言、分类与正文可用性过滤。',
    timeoutMs: BUDGET.news.outer,
    isConcurrencySafe: () => true, // 实测 92ms
    parameters: object({
      language: enumStr('语言（缺省返回各语言混合）', LANGS),
      tag: enumStr('分类', ['event', 'gacha', 'music', 'campaign', 'update', 'information', 'bug']),
      body: enumStr('正文过滤：yes=有正文缓存 / no=仅链接', ['yes', 'no']),
      limit: int('条数上限（≤100）', 20),
    }, []),
    async execute(a, exec) {
      try {
        const data = await call('news', {
          limit: a.limit ?? 20,
          language: a.language,
          tag: a.tag,
          // 三态：缺省必须保持「无正文过滤」，不能塌陷成 false（=「仅无正文」）。
          body: a.body === 'yes' ? true : a.body === 'no' ? false : undefined,
        }, { timeoutMs: BUDGET.news.inner, signal: exec?.signal })
        return compactNews(data)
      } catch (e) { return `ERROR: ${e.message}` }
    },
  },
  {
    name: 'sekai_status',
    description: '报告知识库就绪状态、数据新鲜度、各服覆盖与同步率（只计源站确实提供的内容）。回答时效性问题（活动/卡池/维护）前先查。',
    timeoutMs: BUDGET.status.outer,
    isConcurrencySafe: () => true, // freshness/progress 均为毫秒级端点
    parameters: object({}),
    async execute(_a, exec) {
      try {
        const { data, meta, progress, gaps } = await status({ signal: exec?.signal })
        return compactStatus(data, meta, progress, gaps)
      } catch (e) { return `ERROR: ${e.message}` }
    },
  },
]

/** 供审计脚本与文档使用的预算表（避免脚本解析源码正则）。 */
export const BUDGETS = BUDGET
export { lexiconStatus }

export function apply(ctx, config) {
  // 接收 profile 行的 config（DSH 官方 apply(ctx, config) 机制），
  // 让用户在 cordis.patch.yml 里覆盖 store/python 等，且该层在升级时不会被覆盖。
  setRuntimeConfig(config)
  for (const tool of TOOLS) {
    ctx.effect(() => ctx.tools.register({
      ...tool,
      async execute(args, exec) {
        if (exec?.signal?.aborted) return 'ERROR: 已取消（调用方中止）'
        const missing = missingArgs(tool.name, args)
        if (missing) {
          return `ERROR: 缺少必填参数 ${missing.join(', ')}——本工具的 schema 已声明这些字段；请补齐后重试。`
        }
        if (args != null && (typeof args !== 'object' || Array.isArray(args))) return 'ERROR: 工具参数必须是对象'
        for (const [key, schema] of Object.entries(tool.parameters.properties)) {
          const value = args?.[key]
          if (value === undefined || value === null) continue
          if ((schema.type === 'integer' && !Number.isInteger(value)) ||
              (schema.type !== 'integer' && typeof value !== schema.type) ||
              (schema.enum && !schema.enum.includes(value))) return `ERROR: 参数 ${key} 不符合声明的类型或取值范围`
        }
        return tool.execute(args || {}, exec)
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
    }), `dsh-sekaisync-connect: ${tool.name}`)
  }
  // 服务生命周期：fiber 停止/热重载时杀掉 python 子进程
  ctx.effect(() => () => dispose(), 'dsh-sekaisync-connect: server lifecycle')

  // ── 插件面板：SekaiSync 部署路径选择（官方机制）──────────────────
  // 参照 dsh-experimental-voice-input-bundle：面板后端是一个 Typert Remote 服务，
  // 浏览器半侧通过 ctx.remote.sekaisync.<method>() 调用（不再手写 HTTP 路由），
  // 持久化走 settings.update（写 profile 的 cordis.patch.yml）。
  // 该服务在「有 settings 服务」的组合里才激活；没有 settings 的 profile（纯 CLI）
  // 不注册，面板随之消失，但 10 个工具照常可用。
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.plugin(DeployService)
  })
}
