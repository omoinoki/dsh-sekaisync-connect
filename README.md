# dsh-sekaisync-connect

SekaiSync 知识库的 **DeepSeek Harness 直连模块**：零依赖、零构建、token 最小化。

- **直连**：不走 MCP 协议栈，插件直接拉起 sekaisync 自带的 `serve-http` 子进程（`--port 0` 动态端口，`--no-event-check` 避免启动联网），用 `fetch` 调 REST 端点。
- **随上游演进**：活动解析优先走 sekaisync 新统一端点 `/api/v1/activity`（World Link + 箱活 + unresolved），旧版服务器自动回退 `/api/v1/event_alias`（仅箱活）。
- **最少技术栈**：插件本体 = 2 个纯 ESM JS 文件（`lib/index.js` + `lib/backend.js`），只依赖 Node 内置模块与全局 `fetch`，无 npm 依赖、无构建步骤、无向量库/嵌入模型。Python 侧零改动，复用 sekaisync 官方代码。
- **token 最小化**：
  - 固定 **10 个工具**、短描述、枚举收敛参数（对比 sekaisync 自带 23 个 MCP 工具，首轮 prefill 少一半以上）。
  - 所有结果在插件侧压缩后再进上下文：实体只保留名称/关键事实/信任等级，剧情只保留摘要片段，超长自动截断（默认 6 KB/次）。
  - 事实包自带 `fact_pack_tokens` / `token_ratio` 统计，可直接看到压缩效果。
  - 大 JSON 永远留在本地 store，不进模型上下文（遵循仓库 `docs/TOKEN_BUDGET.md` 原则）。

## 安装

```powershell
# 环境要求：Python ≥ 3.10 且可 `python -m sekaisync`（零第三方依赖），
# 以及一个已同步的 store（sekaisync init / sync 产物）。

# 常规插件装配（bundle patch，DSH 官方机制）
dsh plugin --profile web add <本目录>
```

> 本插件是**标准 bundle 插件**：装配时写入 profile 的 `dependencies`（`link:` 引用）+ `bundles` 列表，
> 由 DSH 官方加载器在启动/热装配时加载。**不依赖 dsh-super-injector 或任何第三方注入工具做运行时挂载**；
> 插件代码本身零第三方依赖，只有 Node 内置模块与全局 `fetch`。
>
> 之所以不 `import '@deepseek-ai/dsh-tools'` 用 `defineTool()`：本插件是 profile 外部的
> `link:` 包，Node 解析不到 harness 内置包（已实测 `ERR_MODULE_NOT_FOUND`，设 `NODE_PATH` 也无效）。
> 一旦引入就会在**加载期**失败，因此维持 `register()` + 自写 JSON Schema，
> 并在插件侧自行补上参数守卫。详见 [`VERIFY-0.3.0.md`](./VERIFY-0.3.0.md) §3.2。

## 插件入口与展示（DSH V0.1.7-rc.2 新增）

0.1.7-rc.2 新增了独立的插件管理面（0.1.5-rc.2 没有）：Web 侧边栏 **Plugins** 页、
`plugin_manager` 工具、Settings 只读插件清单，以及组合期的**兼容性闸门**。
本插件按该入口的契约声明元数据：

| 文件 / 字段 | 作用 |
| --- | --- |
| `locale/en.json`、`locale/zh.json` | 展示用的 `meta.title` / `meta.description`。**只从这里读**——`package.json` 的顶层 `meta` 不会被任何代码读取 |
| `package.json` → `exports` | 必须导出 `"./package.json"` 与 `"./locale/*.json"`，否则新入口静默拿不到展示文本（本机其他插件多缺后者） |
| `package.json` → `icon` | 包内相对路径的图标，限 SVG/PNG/JPEG/WebP、≤256 KiB（本插件为 `icon.svg`，854 B） |
| `package.json` → `dsh.bundle.patch` | bundle 装配依据 |

**兼容性声明**：本插件声明 `peerDependencies`，因为组合期的**兼容性闸门**
（`app-boot:preflight` → `evaluatePluginCompatibility`）读的正是它——
不满足就把该行 **disable**（fail-closed，并给出 `allow-version` 补救方式）。

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.2",
  "@deepseek-ai/dsh-tools": "^0.1.5-rc.2"
}
```

| 运行时 | 判定 |
| --- | --- |
| `0.1.5-rc.2`（插件曾装配的 profile） | allow |
| `0.1.7-rc.2`（**本环境实际运行**） | allow |
| `0.1.8` | allow |
| `0.2.0-rc.1` / `0.2.0` | **DENY**（未验证的版本 fail-closed，用 `dsh plugin allow-version` 豁免） |

两个容易踩错的点（都已实测确认）：

- **`engines.dsh` 不参与闸门**。manifest 文档明确「当前安装器与加载器不强制检查」
  `dsh.manifestVersion` 与 `engines.dsh`；真正执行的是 `peerDependencies`。
  故本插件不声明 `engines.dsh`（声明只增歧义）。
- **闸门用 `includePrerelease: true` 比较**，与 semver 默认语义**不同**。
  默认语义下 `satisfies("0.1.7-rc.2", ">=0.1.5-rc.2") === false`（prerelease 被排除），
  据此会误以为「没有一条范围能同时覆盖 0.1.5-rc.2 与 0.1.7-rc.2」；
  但闸门语义下 `^0.1.5-rc.2` 覆盖**全部 0.1.x**（含 prerelease）并拒绝 0.2.x，
  正是所需的一条范围。
- **不会装出第二份 harness**：实测 pnpm 11 在 `link:` 与 registry 两种安装下
  都**不会**拉取这些 peer（profile 里同样声明了 peer 的 `dsh-zgit`，
  其 `node_modules` 下并没有 `@deepseek-ai`），故无双实例风险。

校验：`scripts/verify-entry-compat.mjs` 逐版本断言上表。

> **注意（本机现状）**：本插件当前只装配在 **web** profile 的
> `dsh.profile.bundles` 里。如果当前 profile 是 **desktop**（本环境的默认），
> 工具表里就看不到 `sekai_*`，Web 侧边栏也不会出现它的条目——这不是插件缺陷，
> 而是它没被该 profile 选中。切到有它的 profile，或把插件加进当前 profile：
>
> ```powershell
> dsh plugin --profile desktop add C:\dsh_projects\dsh-sekaisync-connect
> ```
>
> 加完刷新页面；行装配与展示元数据会一起生效。

## 配置

按优先级：**环境变量 > profile 行 config > `SEKAISYNC_CONFIG` 文件 > 插件目录 `config.json` > 自动发现**。

| 配置项 | 说明 |
| --- | --- |
| `SEKAISYNC_STORE` | store 目录（含 `kb/`）。缺省自动发现：`<SEKAISYNC_ROOT>/store`、cwd/store、`python -c "import sekaisync"` 定位到的仓库 store |
| `SEKAISYNC_ROOT` | sekaisync 仓库根目录（`python -m sekaisync` 的工作目录） |
| `SEKAISYNC_PYTHON` | python 可执行文件，默认 `python` |
| `SEKAISYNC_PORT` | 复用已有服务器的探测端口，默认 8787（若该端口已有 ready 的 sekaisync 服务则直接复用，不另起进程） |

`config.json` 示例（本机默认已指向 `sekaisync-handoff-2026-08-14` 的 store）：

```json
{
  "store": "C:\\dsh_projects\\sekaisync-handoff-2026-08-14\\store",
  "root": "C:\\dsh_projects\\sekaisync-handoff-2026-08-14",
  "python": "python",
  "externalPort": 8787
}
```

也可在自己的 profile patch 里覆盖（该层在插件升级时不会被覆盖）：

```yaml
- id: dsh-sekaisync-connect
  name: 'dsh-sekaisync-connect'
  config:
    store: 'D:\\sekaisync\\store'
    python: 'py'
```

## 工具

| 工具 | 作用 | 典型耗时 |
| --- | --- | --- |
| `sekai_probe` | **内容判定**：**动态热词表**（启动时由 store 构建，9千+ 用语）打分，判断查询是否为《世界计划》相关（返回 verdict=yes/maybe/no），命中项带 `tags`/`weight`/建议的 `next_tool`——不确定话题/陌生名词/来源不明角色名时先探测再决定路由 | 即时（~1 ms） |
| `sekai_lookup` | 实体查询（可玩角色/活动/卡片/卡池/曲目/区域），任意语言名称，跨服名称+关键事实；命中事件或含活动简称/箱活名时自动附带活动解析；配角/NPC 不在档案库（miss 会引导走 sekai_web） | ~2.3 s |
| `sekai_fact` | 按实体 id 取紧凑事实包（生成内容前取事实的最省方式） | ~10 ms |
| `sekai_resolve` | 专有名词 → 官方本地化名称（官方词表翻译记忆），未覆盖的译名如实标注而非留空 | ~1 s |
| `sekai_term` | 游戏用语及跨语言译名，含 `tags`（person/event/product/location/organization/other）、`weight`、出处证据句，可按 tag 与 weight 过滤排序 | ~150 ms |
| `sekai_penetrate` | **跨语言穿透**：取同一剧情点位下各语言的对应词与原文句（含 trust）。用于核对译名在语境中的实际用词，或确认某语言是否真的没有对应行（`missing` 如实声明）。慢 | ~42–99 s（首次） |
| `sekai_alias` | 活动解析：社区简称（khn3 / 豆三箱 / 心羽3）、World Link（wl3 / 25wl / lnwl / vbs wl2 / finale / round2 / wl3gN）与**官方箱活名**（各服官方名均可，如「雨过天晴的启明星」「Smile of a Dreamer」），支持自然问句，含跨服名称、日期、曲目与卡片 | ~0.5–1.5 s |
| `sekai_news` | 五服官方公告查询（2千+条，按语言 ja/en/tc/kr/cn、分类 event/gacha/music/campaign/update/information/bug、正文缓存 body 三维过滤；输出 `[tag] 标题（日期，正文✓/仅链接）URL` 压缩形态） | ~80 ms |
| `sekai_web` | 已爬取剧情全文搜索（引用/梗概；首次加载索引，命中结果缓存 10 分钟）。`include_text=true` 可按需索取正文片段 | 41–142 s |
| `sekai_status` | 就绪状态 + 数据新鲜度 + 各服覆盖 + **同步率**（只计源站确实提供的内容，并列出 `source_unavailable` 数量）+ 词表来源 | ~6–33 s |

## DSH 契约（V0.1.7-rc.2）

- **协作式取消**：每个工具体都观测 `exec.signal`，用户点停止会**立即中止** HTTP 请求
  （而不是让请求在后台继续占着服务器槽位），并返回「已取消」而非误报「超时」。
- **并行分类**：`isConcurrencySafe` 按实测成本声明——`probe`/`fact`/`resolve`/`term`/`news`/`status`
  可并行，`lookup`/`penetrate`/`alias`/`web` 独占。
- **双超时预算**：外层 DSH `timeoutMs` 恒比内层 fetch abort 多 10 s，
  让插件自己的 `ERROR: … 超时` 先返回。`scripts/audit-timeouts.mjs` 断言此性质。
- **参数守卫**：DSH 的 `register()` 路径不校验 arguments（校验属于 `defineTool`，
  而本插件无法 import 它），因此插件自行拦截缺参，省掉一次必然失败的 HTTP 往返。
- **不使用的 0.1.7 特性**：`deferLoading`（会隐藏工具，且 `llm-pi-ai` 直接报
  `UNSUPPORTED_CONTENT`）、`defineTool`（解析不到包）、`ptcRuntime`（不请求 PTC 模式）。
  详见 [`VERIFY-0.3.0.md`](./VERIFY-0.3.0.md) §3。

## 活动解析机制（插件侧，不依赖 sekaisync 本体改动）

- **统一解析器**：简称（khn3/wl3…）、**官方箱活名**（任意服官方名，如「雨过天晴的启明星」「スマイルオブドリーマー」「Smile of a Dreamer」）、自然问句（「笑梦的第3个箱活是什么」）走同一条 `resolveAlias` 管线。
- **全量活动索引**：插件用官方 CLI `sekaisync alias --list` 构建箱活映射（各服官方名+日期+曲目+卡片），内存缓存 30 分钟（store 重同步后自动重建），服务启动后后台预热——箱活名反查无需逐条探测。
- **会话内 TTL 缓存**：lookup/fact/resolve/term/penetrate/web/news 等结果缓存 1–10 分钟，同 query 重复触发零成本。
- **可执行引导**：未命中时返回带具体下一步的消息（配角/NPC → `sekai_web(查询词, 语言)`；活动 → 直接报官方名即可），减少模型外部试探性搜索。

## 使用建议（token 纪律）

1. 生成任何本地化文本前先 `sekai_resolve`；需要精确事实用 `sekai_fact`；别让模型凭记忆回答。
2. 陌生名词/来源不明的角色名/不确定话题，先 `sekai_probe` 判定是不是世界计划内容，再决定走本地工具还是 web。命中项直接给出建议的 `next_tool`。
3. 时效性问题（当前活动/卡池/维护）先 `sekai_status` 看新鲜度与覆盖率。
4. 核对某个译名在具体语境里的用词：`sekai_term` 确证用语存在 → `sekai_penetrate` 看各语言对应行。注意 `missing` 是「该语言没有对应行」的如实声明，不是错误。
5. `sekai_web` 很慢，只在引用剧情原文时用；先试 `sekai_lookup` / `sekai_term`，或先 `sekai_probe` 确认方向。
6. 活动简称或箱活名（箱活或 World Link）直接问即可：`sekai_lookup` 会自动附带活动解析，`sekai_alias` 支持简称/官方箱活名/自然问句。
7. 结果被截断时缩小 `limit` 或换更精确的查询词。

## 故障排查

- `ERROR: 未找到 sekaisync 知识库 store`：设置 `SEKAISYNC_STORE` 或改 `config.json`。
- `ERROR: 无法启动 python …`：确认 `python -m sekaisync --help` 可用；缺包时 `pip install -e <sekaisync 仓库>`。
- 服务器 60 秒冷却：连续崩溃 2 次后暂停自动重启，检查 store 完整性（`python -m sekaisync --no-event-check integrity`）。
- 工具结果里的 `ERROR: HTTP …`：服务器已起但请求失败，多为参数问题；`sekai_status` 可看服务模式与 store 路径。
- `ERROR: 缺少必填参数 …`：插件侧守卫拦截，按提示补齐参数即可。
- `sekai_probe` 显示 `词表来源=static`：动态词表（`terms export`）尚未预热完成或构建失败，
  探针已退化为内置静态词库；稍后重试或检查 store 完整性。


## 2026-09 适配（DSH 0.1.5-rc + SekaiSync SQLite/news 更新）

- **工具 8 → 9**：新增 `sekai_news`（五服官方公告查询，2,031 条，按语言
  ja/en/tc/kr/cn、分类 event/gacha/music/campaign/update/information/bug、
  正文缓存 body 三维过滤；输出 `[tag] 标题（日期，正文✓/仅链接）URL` 压缩形态）。
- **DSH 0.1.5-rc.1/rc.2 破坏性变更核查**：本插件未使用 ctx.agent、Inbox 运行时类
  与 Web plugin panel API，三项 breaking 均不触及；`ctx.tools.register` 的
  output.schema/render 用法在 0.1.5 下保持兼容。MCP pagination 修复与本插件无关
  （HTTP 直连，不走 MCP 栈）。当前插件与 DSH 0.1.2-rc ～ 0.1.5-rc.2 全线兼容。
- **SekaiSync 本体传导**：存储迁移 SQLite（kb/sekaisync.db）后 HTTP API 面向后
  兼容，插件无需改动即获益（聚合端点热路径 0.1s 级）；news 记录新增
  information_type/information_tag/browse_type/platform/body_available 结构化
  字段，`news` 端点支持 language/tag/body 过滤参数，插件已透出。
- **域白名单**：公告正文抓取仅限游戏官方内容域（字节 CDN/活动域 + sekai-web
  两域），社媒/问卷/官网首页链接保持 link-only。


## 2026-09-19 传导核查（上游 0.4.0-alpha）

上游 `sekaisync` 自 2026-09-16（本插件上次适配点）到 0.4.0-alpha（`b237829`，
2026-09-18）的变动已逐面核查，结论：**本插件零改动即兼容，版本号仅随核查升为 0.2.0**。
逐项证据：

| 上游变动 | 对本插件的影响 |
| --- | --- |
| HTTP 参数校验收紧（P15/D15：类型不符/超限一律 400，`limit` 上限 100，`query` 上限 2048 字符） | **兼容**。插件发送的参数全部在新预算内（lookup/term limit=8、web limit=5、news limit=20 ≤ 100；bool 只用 `true`/`false` 合法字面量；`callRaw` 本就过滤空值参数，不触发 `empty_to_none` 边界） |
| news 存储改为不可变 generation + meta 指针（P13/P17） | **透明**。`/api/v1/news` 经 `Core.news` 走 generation 解析，`items[].title/published_at/information_tag/body_available/url` 字段面未变，`compactNews` 无需改动 |
| 事实包 as-of 化、region 感知公开时间过滤、扣留未公开内容（bf37f4a/d1f8f4e/c95787b） | **透明且获益**。`sekai_fact` 响应键（`text`/`trust`/`fact_pack_tokens`/`raw_json_tokens`/`token_ratio`）未变；剧透/未公开内容在上游侧即被扣留，插件压缩层无需感知 |
| `resolve` 未覆盖语义（`translation_status`/`canonical_name`，8d44c69） | **已兼容**（该提交在本插件上次适配点之前，`compactResolve` 已区分「未覆盖」与空串） |
| agent_review 复核权威迁入 SQLite（W4）、术语槽位/复核表新增 | **不触及**。插件不使用术语写路径，只读查询面未变 |
| MCP 协议版本协商、discovery 资源（W3 等） | **不适用**。插件 HTTP 直连，不走 MCP 栈 |
| CLI 面（`serve-http`/`alias --list --regions`、`/health`、启动横幅） | **形状零变化，成本已变**。子命令与参数逐一比对无增减；`SekaiSync HTTP server listening on http://127.0.0.1:<port>` 横幅仍是端口探测依据；`/health` 仍返回 `{status:"ok",ready:…}`。但 `/health` 现在会经 `core.ready()` 走每请求重载，实测 21–40 s（详见下节） |
| `web_lookup` 新增 `include_text`/`max_text_chars` 参数 | **可选能力，暂不透出**。`sekai_web` 的定位是引用/梗概（snippet），透出全文会破坏 token 预算；沿用缺省行为 |

如果后续想让 `sekai_web` 支持按需取原文，可在 `lib/index.js` 的 `sekai_web`
工具上透出 `include_text` + `max_text_chars`（上游已做「先收窄后取正文」，成本可控），
当前版本刻意保持不变的工具集（现为 9 个）。

### 实测复核（2026-09-19，DSH 0.1.5-rc.2）

上表是**静态比对**（逐项读上游代码/CLI 面）。随后在真实 DSH 会话里跑通了
全部 9 个工具做**实测复核**，详见 [`VERIFY-0.4.0-alpha.md`](./VERIFY-0.4.0-alpha.md)。
就 **API 契约**而言「零改动即兼容」成立；就 **可用性**而言不成立，因此插件侧
已按下表调整超时预算与探测策略：

- **上游回归**：0.4.0-alpha 给所有查询方法加了 `@request_scoped`，**每个请求**
  重载并 deepcopy 整个 registry（本机 71,555 实体）。实测 `lookup` 23–38 s、
  `freshness` 21 s、`web_lookup` 64–128 s、`/health` 21–40 s
  （`/health` 也调 `core.ready()`，同样走重载）。
- **工具超时全部抬正**（外层 DSH `timeoutMs` / 内层 fetch abort，外层多留 10 s
  以免 DSH 通用超时抢先掐断）：`lookup` 100/90 s、`fact` 70/60 s、
  `status` 70/60 s、`web` 250/240 s、`resolve` 45/35 s、`term` 45/35 s、
  `news` 45/35 s、`alias` 70/60 s；`probe` 纯本地不变。
- **健康探测预算修正**：`/health` 实测 21–40 s，而旧探测预算是 1200/1500 ms，
  **永远不可能命中**——外部端口复用因此永久失效，且 30 s 内会发出 35 次全被
  中止的探测，把服务器（`MAX_CONCURRENT_REQUESTS=16`）打成不可用
  （实测 `lookup` 从 20.7 s 退化为 90 s 超时且不自愈）。现改为
  `PROBE_EXTERNAL_MS=30 s` / `PROBE_MANAGED_MS=60 s` / `MAX_READY_ATTEMPTS=2`
  （少量、每次给足预算，取代密集轮询）。
- **实测结果**：`scripts/verify-040.mjs` 对 0.4.0-alpha 服务器 **12/12 通过**；
  `scripts/audit-timeouts.mjs` 断言每个工具「外层 > 内层」。
- ~~**仍待上游治本**：每请求 `load_entities` + 双重 deepcopy、`/health` 走 registry
  深拷贝、中止请求的槽位回收。~~ → **上游已修复（2026-09-20 复验）**，见下。

### 上游修复与复验（2026-09-20）

上游提交 `d4cf781`（`fix(core): requests reuse revision-keyed snapshot; /health
answers O(1)`）修掉了上文两处根因，随后 `6c56c3d`/`2e6d0bf` 等继续前进。
插件侧独立复验（详见 VERIFY §八）：

| 端点 | 修复前 | 修复后（实测） |
| --- | --- | --- |
| `/health` | 21–40 s | **35 ms** |
| `lookup` 冷 / 暖 | 23–38 s | **2.4 s / 2.3 s** |
| `freshness` | 21 s | 4265 ms 冷 / **7 ms 暖** |
| `fact_pack` | 21 s | **5 ms** |
| `term_lookup` / `resolve` / `news` | 6–25 s | **144 / 969 / 73 ms** |
| `web_lookup` | 64–128 s | **121 s（未改善，见下）** |

- **探测风暴根因已消除**：用**原始** 1200/1500 ms 预算复测，就绪探测第 1 次即
  成功、外部端口复用恢复、20 s 密集探测 **65/65 成功**且之后 `lookup` 仍正常。
  故插件当前的放宽值（30/60 s、2 次）**不再是必需**，保留仅作安全垫：
  对修复后的毫秒级 `/health` 零成本，对未升级的 0.4.0-alpha 服务器则是唯一可用路径。
- **顺带获益**：`2e6d0bf` 修掉 `load_news` 按 store 物理顺序（≈最旧优先）返回的
  问题——此前任何 `[:limit]` 只看得到 2020 年窗口。复验：`news` 首条由
  2026-08-23 → **2026-09-30**，`limit=20/100` 均严格降序，`compactNews` 无需改动。
- **API 面未受影响**：`tools.py` 仅新增 `query` 的 `include_web`（插件不调用
  `query`）；`news` 参数与响应字段无变化。
- **仍待关注**：`web_lookup` 仍 **121 s**——`web_search` 的全量线性 Python 评分
  （Astra P06 为保 recall 刻意保留），与快照重构无关。内层 240 s / 外层 250 s
  预算继续覆盖，但这是当前唯一的秒级以上工具，值得上游后续单独优化。

## 2026-09-28 适配（DSH V0.1.7-rc.2 + SekaiSync 0.4.0-alpha，插件 0.3.1）

本轮把两侧的**大规模调整**同时纳入。完整依据、实测数据与拒绝理由见
[`VERIFY-0.3.0.md`](./VERIFY-0.3.0.md)。摘要：

> 0.3.0 → **0.3.1**：修正了校验方法本身的一处缺陷（asar 抽取偏移差 2 字节，
> 导致装配验证测到了 0.1.5-rc.2 而非本环境真实运行的 0.1.7-rc.2）。
> 现在 `verify-activation.mjs` 默认对着 `app.asar` 装配并打印被测版本。
> 其余适配结论经复核未变。详见 VERIFY §1.1。

### DSH V0.1.7-rc.2

| 变更 | 处置 |
| --- | --- |
| `exec.signal` 协作式取消真正生效 | **已接线**：`linkSignals()` 把调用方信号与插件超时合成一个 signal，取消立即中止 fetch、不重试，并返回「已取消」而非「超时」 |
| `isConcurrencySafe` 参与并行调度 | **已分类**：毫秒级端点（probe/fact/resolve/term/news/status）可并行，重查询（lookup/penetrate/alias/web）独占 |
| `timeoutMs` 明确为「声明」，由 `dsh-tool-call-timeout-policy` 执行 | 双预算维持，并按 0.4.0-alpha 实测重排；`audit-timeouts.mjs` 改为读导出的 `BUDGETS` + 反向孤儿断言 |
| `ptcRuntime`（原 `codeRuntime`）改名 | **不触及**（不请求 PTC 模式） |
| `deferLoading` 获得实际语义 | **刻意不用**：会隐藏工具，且 `llm-pi-ai` 遇到它直接抛 `UNSUPPORTED_CONTENT`；还会让 session format v3→v4 迁移拒绝该会话 |
| `defineTool()` DSL 可用 | **刻意不用**：profile 外部的 `link:` 包解析不到 `@deepseek-ai/dsh-tools`（实测 `ERR_MODULE_NOT_FOUND`），一旦 import 插件在加载期即失败 |
| `apply(ctx, config)` 行配置 | **已接入**：可在 `cordis.patch.yml` 覆盖 store/python 等，且升级不覆盖 |
| 根 `register()` 不校验 arguments | **补插件侧守卫**：缺参变成自解释消息，省掉一次必然失败的 HTTP 400 |

### SekaiSync 0.4.0-alpha

| 变更 | 处置 |
| --- | --- |
| **新增 `/term_penetrate`**（同点位跨语言穿透），上游 `docs/DSH_PLUGIN_GUIDE.md` §2.3 明确要求消费 | **新增第 10 个工具 `sekai_penetrate`**。`missing:true` 是「该语言无对应行」的**如实声明**，压缩器渲染为「（无对应行）」而非丢弃或空串 |
| **热词表应从静态数组改为启动时构建**（指南 §2.1） | **已实现**：数据源选 `terms export --format json`（1.6 s vs `/tag_clouds` 20.2 s），按 tag/weight 分档；两处按实测修正——跨作品门控（`初音ミク`/`MEIKO` 不再单独判 yes）与前缀命中（指南 §4 的 `Solis → [organization]` 在真实 store 里规范名是 `ソリス・レコード`） |
| `term_lookup` 新增 `tag` / `sort` | 已透出；`compactTerm` 输出 `tags=` / `weight=` / `occ=` / `未认证语言=` |
| `web_lookup` 的 `include_text` / `max_text_chars` | 已透出（默认关闭，按需索取，不破坏 token 预算） |
| `news` 新增 `count`/`available`/`information_type` 等字段 | `compactNews` 输出总条数与 `information_type` |
| `/progress` 改为「只计源站确实提供的内容」（98% 口径） | `sekai_status` 增加覆盖率和 `source_unavailable` 数量（该端点毫秒级） |
| **P15 参数边界**（`limit≤100`、`query≤2048`、越界一律 400） | `sanitizeParams()` 在发出前收敛，把「参数越界」变成一次成功调用 |
| v3 store 用 `zh_hant`，而上游 `resolve` 默认 `zh_tw` | **如实回退**：先按调用方语言查询，仅当整批「未覆盖」时用变体重试一次，并在结果里标注实际语言（不静默改写） |
| `core.fact_pack` 有 `region`/`as_of`，但 HTTP 路由**未声明** | **不暴露**：`coerce_args` 只读 `spec.args`，传了会被静默忽略；不隐藏一个假参数 |
| 同步率、逐区服事实、逐语言槽、不可变代际发布 | 查询侧无需改动；`resolve`/`term` 的「未覆盖/未认证语言」已在压缩层如实呈现 |

**实测**：`scripts/verify-017.mjs` **21/21 通过**、`scripts/verify-activation.mjs`
（真实注册表进程内装配）通过、`audit-timeouts.mjs` 10/10、
10 个工具 schema 全部通过 DSH 的 `assertSupportedJsonSchema`。



