# dsh-sekaisync-connect 0.3.1 × DSH V0.1.7-rc.2 × SekaiSync 0.4.0-alpha 核查

本文件记录 0.3.x 的适配依据：逐面读取两侧实现、逐项实测。
上一轮（0.2.x）的核查保留在 [`VERIFY-0.4.0-alpha.md`](./VERIFY-0.4.0-alpha.md)。

> **版本说明**：0.3.0 是首轮适配；**0.3.1** 修正了本轮发现的
> 「asar 抽取偏移差 2 字节 → 装配验证测错运行时版本」的方法论缺陷（§1.1），
> 并把装配验证改为默认对着 `app.asar`（真实运行版本）执行。
> 其余结论均已用修正后的数据复核，未变。

**总结论**：0.1.7-rc.2 对工具注册面的**契约是兼容的**（无需迁移）；
0.4.0-alpha 的 **API 面兼容、但有三个能力缺口值得消费**（动态词表、跨语言穿透、
P15 参数边界），已全部落实。另修正了一处 0.2.x 遗留的真实缺陷（见 §4.1）。

---

## 一、环境事实（先确认基线，避免把「另一个 profile / 另一个版本」当成结论）

**本环境运行的就是 DSH V0.1.7-rc.2**（desktop profile，`resources/app.asar`）。
这一点由三方证据交叉确认：

- `resources/runtime/primary-runtime/runtime.json` → `desktopVersion: "0.1.7-rc.2"`；
- `app.asar` 内 `dsh/package.json` → `@deepseek-ai/dsh-desktop-runtime@0.1.7-rc.2`；
- **运行时自证**：`cordis_inspect_query` 的 `Config` provider 把
  `include:tools` / `include:plugin-manager` 的 `packageDir` 解析到
  `…\resources\app.asar\dsh\node_modules\@deepseek-ai\…` ——
  这是当前进程**真正加载**的那份代码，也就是 0.1.7-rc.2。
  （`@deepseek-ai/dsh-plugin-manager` 本身只存在于 0.1.7-rc.2，它的出现即佐证。）

| | 版本 | 位置 | 说明 |
| --- | --- | --- | --- |
| **本会话宿主（desktop profile）** | **0.1.7-rc.2** | `resources/app.asar` | 我实际对话所在进程；本次核查的**权威对象** |
| profile 的 `@deepseek-ai/*` junction | 0.1.5-rc.2 | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh` → junction 到 `harness-rc2`（一份源码 checkout） | **仅用于解析 profile 安装的插件包**，不是宿主核心的版本 |
| `harness` / `harness-new` / `harness-rc2` 源码 checkout | 0.1.5-rc.2 / 0.1.5-alpha.1 / 0.1.5-rc.2 | `C:\GreenApps\DeepSeekHarness-Desktop\…` | 与宿主版本**无关**，不要当成被测对象 |
| 上游 SekaiSync | **0.4.0-alpha**（`4a78e48`） | `C:\dsh_projects\sekaisync-handoff-2026-08-14` | store 已迁到 schema **v3** |
| store | schema v3，`data_revision=61` | `store/kb/sekaisync.db`（2.16 GB） | `entities=73849`、`terms=9190`、`web_pages=752468` |

> 0.1.7-rc.2 的代码只存在于 `app.asar` 内。核查方式是把它提取出来逐行阅读
> （提取脚本 `scripts/extract-asar-runtime.mjs`，见 §6），而不是靠印象推断。

### 1.1 一处曾被做错、现已修正的方法论（重要）

初次核查时我用 `16 + u32(12)` 作为 asar 数据段起点，**结果少了 2 字节**：
每个抽取出的文件头部多 2 个垃圾字符、尾部少 2 字节。文本文件"看起来仍能读"
（这也是当时没发现的原因——只看到 `ap{`、`>`、`|` 之类的怪前缀，误当作无关紧要），
但字节级判断会失真。

正确公式（Pickle 布局）：

```
u32(0)=4 · u32(4)=header 载荷长 · u32(8)=JSON 长+4 · u32(12)=JSON 长
目录 JSON 位于 [16, 16+u32(12))
数据段起点 = align4(8 + u32(4))     ← 不是 16 + u32(12)
```

**后果**：当时跑 `verify-activation.mjs` 走的是 `profiles/node_modules` 那份
**0.1.5-rc.2** 的 `@deepseek-ai/dsh-tools`，而不是本环境真实运行的 0.1.7-rc.2。
也就是说，"装配通过"这个结论当时**测的是错的版本**。

**修正**：

1. `scripts/extract-asar-runtime.mjs` 用正确偏移抽取，并**自检**
   （抽取后立刻用已知 JSON 文件验证数据段偏移，算错就报错退出）；
2. `scripts/verify-activation.mjs` 默认**自动定位 `app.asar`** 并对着它装配，
   运行时版本会被打印出来（`runtime: @deepseek-ai/dsh-tools 0.1.7-rc.2`），
   只有当找不到 asar 时才退回 junction 并**显式告警**。

修正后重跑，10/10 工具在**真实 0.1.7-rc.2** 上装配通过（§5.2）。
本文件其余结论均已用修正后的抽取结果**复核过**（§2.1 表格第三列）。

---

## 二、DSH V0.1.7-rc.2：契约面核查

### 2.1 结论表

| 契约点 | 0.1.5-rc.2 | 0.1.7-rc.2 | 本插件 | 处置 |
| --- | --- | --- | --- | --- |
| `ctx.tools.register(def)` 必须声明 `output { schema, render }` | 是 | **同**（逐字相同，含 `presentationMeta?` 检查） | 已声明 | 无需改动 |
| `register()` 执行前**不**校验 `arguments` | 是 | **同** | 0.2.x 依赖上游 400 | **补插件侧守卫**（§4.3） |
| `output.schema` 需过 `assertSupportedJsonSchema` | 是 | **同**（子集：`type/oneOf/properties/required/additionalProperties/items/enum/const` + `description/title/default/examples`） | `{type:'string'}` + 枚举属性 | 10/10 通过（§5.1） |
| 返回值必须匹配 `output.schema` | 是 | **同**（`createSuccessResult` 里 `validateJsonSchemaValue(tool.output.schema, …)`） | 恒返回 string | 通过 |
| `timeoutMs` 校验（正有限数） | 是 | **同** | 合法 | 通过 |
| `timeoutMs` **是否被强制执行** | 由 `dsh-tool-call-timeout-policy` 在 `tools/execute` 上执行 | **同**（`ctx.tools.get(exec.name, exec.agent)?.timeoutMs`） | 外层 > 内层 | 保留双预算（§4.4） |
| `exec.signal`（协作式取消） | 传入工具体，必须观测 | **同** | 0.2.x 只用自己的 `AbortController` | **已接线**（§4.2） |
| `isConcurrencySafe(args)` | 存在 | **同**（`executionMode()` 只认精确 `true`） | 未声明 → 全部独占 | **已分类**（§4.5） |
| `deferLoading: true` | 存在但无行为 | **新增实际语义** | 未使用 | **刻意不用**（§3.1） |
| `ctx.effect(() => …)` 清理 | 支持 | 同 | 已用 | 无需改动 |
| bundle patch（`package.json.dsh.bundle.patch`） | 支持 | 同 | 齐全 | 无需改动 |
| `defineTool()` DSL | 已导出 | 同 | **无法使用** | 见 §3.2 |

### 2.2 唯一的破坏性面：`ptcRuntime` 改名（不触及本插件）

0.1.7 把 `ctx.codeRuntime` 改名为 `ctx.ptcRuntime`
（`requireCodeRuntime` → `requirePtcRuntime`，`CodeRuntime` → `PtcRuntime`）。
本插件不请求 PTC 模式、不读该服务、也不声明 `presentAs`，故不受影响。
若将来想让本插件支持 PTC 呈现，需按 0.1.7 的新名字接入。

---

## 2.3 新增的独立插件入口（本轮补充核查）

0.1.7-rc.2 引入了一个 0.1.5-rc.2 **完全没有**的插件管理面。
判定依据（两侧均为直接读取，非推断）：

| 包 | 0.1.7-rc.2（`app.asar`） | 0.1.5-rc.2（`harness-rc2/apps/cli`） |
| --- | --- | --- |
| `@deepseek-ai/dsh-plugin-manager` | 有（`include:plugin-manager` 行，`Config` provider 可查到 schema） | **不存在** |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | 有（Web Plugins 页） | **不存在** |
| `@deepseek-ai/dsh-config-editor` | 有（`include:config-editor` 行） | **不存在** |

（0.1.5-rc.2 侧只存在 `dsh-host-plugin-inventory` 与
`dsh-client-ui-settings-plugin-inventory` 这两个**只读**清单。）

| 入口 | 形态 | 对插件的要求 |
| --- | --- | --- |
| **Web 侧边栏 Plugins 页** | `@deepseek-ai/dsh-client-ui-plugin-manager` | 读展示元数据与 bundle 行 |
| **`plugin_manager` 工具** | `@deepseek-ai/dsh-plugin-manager/tools`（`dsh-base` 里的独立行，Creator 模式启用） | 同上（但 **不含** UI 展示元数据） |
| **Settings 只读插件清单** | `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` | 同上 |
| **组合期兼容性闸门** | `app-boot:preflight` → `evaluatePluginCompatibility` | 读 `peerDependencies`，不兼容即整行 `disabled` |

因此「插件清单」不再只是 `package.json` 里一行名字，而有了**会被读取的展示与装配契约**。
本轮据此补齐了三处（此前 0.3.0 草案里写错或漏写）：

#### 2.3.1 展示元数据只从 `locale/*.json` 读，`package.json` 的 `meta` 是死字段

`app-boot:readPluginMeta(specifier, parentURL)`（`lib/index.js:1969`）的实际读取路径是：

```
specifier/package.json     → name / description（回退值）、icon
specifier/locale/en.json   → meta.title / meta.description（必需英文回退）
specifier/locale/*.json    → 其余语言字典
```

它**从不读** `package.json` 的顶层 `meta`——我在 0.3.0 草案里加的那个字段是死代码，
已删除。现在标题/描述只放在 `locale/en.json` 与 `locale/zh.json`：

```
title      = {"en":"SekaiSync Connect","zh":"SekaiSync Connect"}
description= {"en":"Direct-connect module for a local SekaiSync …","zh":"把本地 SekaiSync 知识库…"}
icon       = {"state":"ok","mediaType":"image/svg+xml","bytes":854}
```

#### 2.3.2 这些资源必须经 Node `exports` 导出

`readPluginMeta` 用**完整包标识**解析资源（`${specifier}/locale/en.json`），
所以缺 `exports` 子路径就会静默拿不到展示文本。实测对比（同 profile 内的其他插件）：

| 包 | `./package.json` | `./locale/*.json` | 结果 |
| --- | --- | --- | --- |
| **dsh-sekaisync-connect** | OK | **OK** | 能读到本地化 title/description |
| dsh-zgit | OK | `ERR_PACKAGE_PATH_NOT_EXPORTED` | 只有包名级文本 |
| dsh-better-sidebar | OK | `ERR_PACKAGE_PATH_NOT_EXPORTED` | 只有包名级文本 |
| whale-girl | OK | `ERR_PACKAGE_PATH_NOT_EXPORTED` | 只有包名级文本 |

0.3.0 已导出 `"."`、`"./package.json"`、`"./locale/*.json"`。

#### 2.3.3 `icon` 是新增的、会被严格校验的字段

`app-boot:iconOf` 的规则比文档更严：必须 manifest 相对路径、
扩展名限 SVG/PNG/JPEG/WebP、realpath 后仍在包内、≤256 KiB，
否则**产生元数据诊断**（其余文本保留，但图标丢失）。0.3.0 新增 `icon.svg`
（854 B，`iconOf` 复刻校验通过），并在 `files` 里列出。

#### 2.3.4 兼容性闸门读的是 `peerDependencies`，不是 `engines.dsh`

这是本轮最容易踩错的一处。`app-boot:preflight`（`lib/index.js:2057`）在组合期
对每个 profile 行调用：

```js
const issue = evaluatePluginCompatibility(manifest, exemptions)
if (issue && !issue.exempted) { row.disabled = true; report(row, warning) }   // 整行失效
```

而 `evaluatePluginCompatibility`（`lib/index.js:287`）：

- **只读 `peerDependencies`** 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的项；
- 没有该字段就直接放行；
- 比较时带 `{ includePrerelease: true }`。

两个推论：

1. **`engines.dsh` 是纯声明，不参与闸门**。manifest 文档自己写明
   「当前安装器和加载器不强制检查 `dsh.manifestVersion` 或 `engines.dsh`」。
   本插件因此**不声明** `engines.dsh`——声明它不会带来任何保护，只增加歧义。
2. **应当声明 `peerDependencies`**，因为那正是闸门读取的字段。本插件声明：

   ```json
   "peerDependencies": {
     "@deepseek-ai/cordis": "^4.0.2",
     "@deepseek-ai/dsh-tools": "^0.1.5-rc.2"
   }
   ```

   判定结果（`scripts/verify-entry-compat.mjs` 逐版断言）：

   | 运行时 | 判定 |
   | --- | --- |
   | `0.1.5-rc.2`（插件曾装配的 profile） | allow |
   | `0.1.7-rc.2`（**本环境实际运行**） | allow |
   | `0.1.8` | allow |
   | `0.2.0-rc.1` / `0.2.0` | **DENY**（未验证版本 fail-closed，可用 `dsh plugin allow-version` 豁免） |

##### 关于 semver 的一处**自我更正**（重要）

本文档早期版本写过一条错误结论：

> ~~「没有一条 semver 范围能同时匹配 0.1.5-rc.2 与 0.1.7-rc.2 而排除 0.2.0」~~

这是**错的**，因为它用的是 semver **默认**语义。实测默认语义下确实如此：

```
satisfies("0.1.7-rc.2", ">=0.1.5-rc.2")                       === false   ← 默认语义
satisfies("0.1.7-rc.2", ">=0.1.5-rc.2", {includePrerelease:true}) === true  ← 闸门语义
```

**但闸门带 `includePrerelease: true`**，语义完全不同。在该语义下
`^0.1.5-rc.2`（对 0.x 等价于 `>=0.1.5-rc.2 <0.2.0-0`）即可：

| 范围 | 0.1.4-rc.1 | 0.1.5-rc.2 | 0.1.7-rc.2 | 0.1.8 | 0.2.0-rc.1 | 0.2.0 |
| --- | --- | --- | --- | --- | --- | --- |
| `^0.1.5-rc.2` | DENY | allow | allow | allow | DENY | DENY |

一条范围就够，正是所需。

##### 声明的代价与已排除的风险

- **代价（如实记录）**：DSH 在 `0.2.x` 上会把本插件**整行 disable**（fail-closed）。
  这是闸门的设计意图——未验证的宿主宁可拒绝也不静默带病运行；
  解除方式是 `dsh plugin allow-version` 或 plugin_manager 的版本豁免。
  若不声明 peer，则任何版本都会放行（无保护）。
- **已排除的风险：不会装出第二份 harness**。担心的是 pnpm 的
  `autoInstallPeers`（默认 true）会因这些 peer 从 npm 拉取 `@deepseek-ai/*`，
  从而在 profile 里产生与宿主并存的第二份运行时。实测三种情形**都不会**：

  | 情形 | 结果 |
  | --- | --- |
  | `link:` 本地包声明 `@deepseek-ai/dsh-tools` peer | 未安装 |
  | 从 registry 装 `@deepseek-ai/dsh-plugin-manager`（声明多个 `@deepseek-ai/*` peer） | 未安装 |
  | **真实 profile**：`dsh-zgit` 声明了 harness peer | 该 profile 的 `node_modules` 下**没有** `@deepseek-ai` |

  故不存在双实例风险。这也与生态现状一致：`dsh-zgit` 与 `dsh-better-sidebar`
  都声明 harness `peerDependencies`。

  > **一处措辞的澄清**：`cordis-plugin-development/SKILL.md` 说
  > "Packages shipped with dsh resolve from the dsh installation,
  > so the bundle declares no **dependencies** on them."
  > 本文档早期版本据此推断「不应声明 harness peer」——**这是误读**。
  > 该句约束的是 `dependencies`（会触发安装/解析），而 `peerDependencies`
  > 恰恰是「只声明兼容性、不要求安装」的字段，也正是闸门读取的字段。
  > 实测已确认 pnpm 不会因 peer 安装这些包（上表），两者并不矛盾。

> 补充：`dsh.bundle.patch` 仍是装配依据，`dsh.manifestVersion: 1` 保留为声明。
> 行 `config` 经 `apply(ctx, config)` 传入（§4.10），两条路径都已在实测中验证。

---

## 三、两处**刻意不做**的 0.1.7 新特性（附拒绝理由）

### 3.1 不使用 `deferLoading`（延迟加载工具定义）

0.1.7 让 `deferLoading: true` 真正生效，看似适合「第 10 个工具」的成本控制。
但实际语义与风险都不合适：

1. **它不会让工具自动可用**。`dsh-llm` 的 `projectToolUpdates` 只有在会话历史里
   存在对应的 developer「工具新增」记录时才把定义补进请求；
   `offered` 集合显式排除带 `deferLoading` 的工具
   （`history.tools.filter((tool) => !tool.deferLoading)`）。
   裸注册一个延迟工具**等于把它藏起来**，不是「按需加载」。
2. **它会打断非原生 provider**。`@deepseek-ai/dsh-llm-pi-ai` 遇到任何
   `deferLoading: true` 直接抛错：
   `throw new LlmError("Deferred tool loading is not supported yet", "UNSUPPORTED_CONTENT")`。
   本 profile 恰好挂着 `llm-pi-ai`，一旦声明就是硬失败。
3. **它会污染会话格式迁移**。`dsh-session-format-v3-to-v4` 规定：
   V3 的工具定义若带顶层 `deferLoading`（V4 才有的字段）就**拒绝迁移**。

工具数量的成本改用「固定 10 个 + 短描述 + 枚举收敛」控制，
实测 10 个工具的参数 schema 合计仍然很小（§5.1 的 props 统计）。

### 3.2 不使用 `defineTool()`（改用 `register()` 裸定义）

`defineTool` 会额外提供两样本插件真正需要的东西：编译期参数校验、
以及 `InferArgs` 类型。两者都要求 `import { defineTool } from '@deepseek-ai/dsh-tools'`。

实测该 import 在插件所在位置**必然失败**：

```
$ node -e "import('@deepseek-ai/dsh-tools')"      # cwd = 插件目录
FAIL @deepseek-ai/dsh-tools :: ERR_MODULE_NOT_FOUND
```

原因：本插件是 `link:` 到 profile 的**外部包**，位于 profile 目录树之外，
Node 的解析链从 `C:\dsh_projects\dsh-sekaisync-connect` 逐级向上找
`node_modules`，而该链上**没有任何** `node_modules`：

```
C:\dsh_projects\dsh-sekaisync-connect\node_modules   (不存在)
C:\dsh_projects\node_modules                          (不存在)
C:\node_modules                                       (不存在)
```

harness 内置包只存在于 profile 自己的 `node_modules`（以及 `app.asar`），
既不在插件的向上解析链上，也不经由 `NODE_PATH` / `.dsh-module-fallback`
（实测三种方式 `ERR_MODULE_NOT_FOUND`，`--preserve-symlinks` 亦然）。
一旦 `import '@deepseek-ai/dsh-tools'`，插件在**加载期**就会挂掉——
比缺少校验严重得多。

因此维持 `register()` + 自写 JSON Schema，并自己补上 `defineTool` 提供的
校验能力（§4.3）。这也是「零依赖、零构建」这一设计目标的自然后果。

---

## 四、本版实际改动

### 4.1 修正 0.2.x 的真实缺陷：`activity` 的 `regions` 参数形状

0.2.x 的 `resolveAlias(query, regions)` 直接把工具参数原样传给
`loadAliasIndex()`，后者按 `regions.join(',')` 处理。但工具 schema 把
`regions` 声明为 **string**（`regions: str('区域列表，逗号分隔')`），
于是 `[].join` 从未被走到，`aliasMapCache` 的 `regionsKey` 会退化成
`DEFAULT_REGIONS`；更实际的问题是 **`/activity` 收到的是逗号串而它期望
`csv_or_list`**，形状对不上时任何异常都被 `catch` 吞掉，表现为「静默退化」。

0.3.0 增加 `sanitizeParams()`，对 `region` / `regions` 统一做
「拆分 → 小写 → 白名单过滤 → 重新拼接」，`/activity` 与 `/lookup` 走同一条收敛路径。

### 4.2 `exec.signal` 真正接进 fetch（协作式取消）

0.1.7 的取消契约是**协作式**：宿主只把 `exec.signal` 交给工具体，
工具不观测它，取消就不会生效。0.2.x 只用了插件自己的超时 `AbortController`，
所以用户点「停止」后，插件仍在打 HTTP、仍占着服务器的槽位。

0.3.0 的 `linkSignals(callerSignal, timeoutMs)` 把两者合成一个信号：
调用方中止 → 立即中止 fetch，且**不重试**（重试一个被用户取消的请求是错的），
并返回「已取消」而不是误报成「超时」：

```
PASS       0ms  取消信号：已中止的 signal 立即结束调用
       lookup 已取消（调用方中止）
```

### 4.3 参数守卫（补 `defineTool` 缺失的那一层）

由于 §3.2，schema 里的 `required` 对模型只是**声明**：DSH 不校验，
真正拦截的是上游 HTTP（返回 400）。0.2.x 于是把
`ERROR: HTTP 400: {"error": "missing required parameter 'query'"}` 交给模型。

0.3.0 在 `apply()` 里包一层守卫，把缺参变成自解释消息，并省掉一次必然失败的
HTTP 往返（也少占一个 `MAX_CONCURRENT_REQUESTS=16` 的槽位）：

```
missing-required arg -> ERROR: 缺少必填参数 query——本工具的 schema 已声明这些字段；请补齐后重试。
```

### 4.4 超时预算按实测重排

外层 = DSH `timeoutMs`（由 timeout-policy 执行），内层 = 插件 fetch abort；
外层恒比内层多 **10 s**，好让插件自己的 `ERROR: … 超时` 先返回。
本机（v3 store，修复后的 0.4.0-alpha）实测：

| 端点 | 实测 | 内层 / 外层 |
| --- | --- | --- |
| `lookup` 星乃一歌 | 2.3 s | 140 / 150 s |
| `fact_pack` | 5–12 ms | 110 / 120 s |
| `freshness` | 7 ms 暖 | （status 内） |
| `resolve` | 0.9–1.3 s | 110 / 120 s |
| `term_lookup` | 131–195 ms | 110 / 120 s |
| `term_penetrate` | **42–99 s** | 190 / 200 s |
| `news` | 76–92 ms | 110 / 120 s |
| `activity`（khn3 / wl3） | 0.5–1.5 s | 140 / 150 s |
| `web_lookup` | **41–142 s** | 250 / 260 s |
| `status`（冷） | 6–33 s | 170 / 180 s |

预算普遍抬高是**为首次调用买单**：插件自管子进程的冷启上限是
`START_TIMEOUT_MS=120 s`（含 registry 构建 + SQLite 打开），
第一次调用可能把冷启与查询叠在一起。

### 4.5 `isConcurrencySafe`：按实测成本分类

0.1.7 的调度器只认精确 `true` 为「可并行」，其余（未声明 / 抛错 / 非 true）
一律独占。先前的「全部独占」浪费了毫秒级端点的并行能力；0.3.0 按实测分类：

| 可并行（`true`） | 独占（`false`） |
| --- | --- |
| `sekai_probe`（纯本地，无 HTTP） | `sekai_lookup`（触碰 registry 快照） |
| `sekai_fact`（5–12 ms） | `sekai_penetrate`（42–99 s） |
| `sekai_resolve`（0.9–1.3 s） | `sekai_alias`（含活动索引构建） |
| `sekai_term`（131–195 ms） | `sekai_web`（41–142 s） |
| `sekai_news`（76–92 ms） | |
| `sekai_status`（毫秒级端点） | |

### 4.6 第 10 个工具：`sekai_penetrate`（跨语言穿透）

0.4.0-alpha 新增 `/api/v1/term_penetrate`，上游还专门为本插件写了
`docs/DSH_PLUGIN_GUIDE.md` §2.3 要求消费它。返回同一 `story_key` 下各语言的
`term/sentence/trust`。

**实测要点（决定了压缩器写法）**：它经常返回 `missing: true`——
本机对 `ネットパラダイス` 的 `ja` / `zh_hans` 都是 `missing`，只有 `en` 有内容。
`missing` 是「该语言在这一行没有对应文本」的**如实声明**（译文未覆盖，
或该行在对应语言中不存在），不是错误。因此 `compactPenetrate` 把它渲染成
`（无对应行）` 并汇总一行说明，而不是丢掉或伪装成空串：

```
ネットパラダイス [product] weight=2.8435 occ=14 trust=C
story_key=event:168:2 cloud_rank=492
ja: （无对应行 trust=B）
zh_hans: （无对应行 trust=B）
en: [NetParadise] Arisawa：With regards to the final stage, ... trust=B
（ja/zh_hans 无对应行——译文未覆盖或该行在对应语言中不存在）
```

> 上游指南 §2.3 建议「`probeSekai` 判 `maybe` 时自动穿透确证」。
> **未采用**：`probe` 是零成本纯本地探针，自动穿透会把它的成本从 ~1 ms
> 抬到 42–99 s，与「廉价路由探针」的定位直接冲突。
> 改为在 `hits` 里给出 `next_tool` 建议，由模型决定是否再调用（§4.7）。

### 4.7 `probeSekai`：静态热词数组 → 动态词表

上游指南 §2.1 指出 0.2.x 的 `SEKAI_LEXICON` 是手写 40+ 角色名，
应改为「启动时从 store 构建」。0.3.0 的数据源选择经过实测比较：

| 候选 | 实测 | 结论 |
| --- | --- | --- |
| `GET /tag_clouds` | 20.2 s，1.03 MB | 太慢（每次刷新都要付） |
| `GET /term_lookup?query=__all__` | 上游无此用法 | 不成立 |
| **CLI `terms export --format json`** | **1.6–2.0 s，2.3 MB** | **采用**（与 `alias --list` 同一路径，零第三方依赖） |

分档按指南实现：`person`/`event` 且 weight Top 2000 → tier 3；
`product`/`location`/`organization` → tier 2；其余 → 1。
`hits` 带上 `tags` / `weight` / `next_tool`（指南 §2.1 要求的形态）：

```
probe: 神山高校文化祭在哪办 → yes（score=5，词表来源=terms_export）
• ……文化祭？ [event] w=2.8576 → sekai_penetrate
• 神山高校 [location] w=5.1857 → sekai_penetrate
```

**两处按实测做的修正**（指南的伪代码在此不完全可执行）：

1. **跨作品门控**。指南要求「Vocaloid 六子一律按 product/other 处理，
   需与 person/event 共现才升为 yes」。仅按 tier 打分做不到这点：
   `MEIKO`（`tags=[other,person]`，weight 15.2）会单独把判定推到 yes。
   0.3.0 引入 `crossWork` 标记（名字表 + 前缀规则）并压到 tier ≤ 2，
   同时要求 `verdict=yes` 必须存在**一个非跨作品的 tier ≥ 2 信号**：

   ```
   probe: 初音ミク → maybe（score=4）        # 6 个命中里有跨作品项，仍不判 yes
   probe: 帮我写一个快速排序 → no（score=0）
   ```
2. **前缀命中**。指南 §4 的抽样用例 `Solis → [organization]`，
   在真实 store 里条目规范名是 `ソリス・レコード`，只有 `names.en = "Solis Records"`。
   纯「包含」匹配会漏掉它。0.3.0 增加「查询是某个较长键的前缀」这一路
   （封顶 tier 2，因为证据比完整命中弱）：

   ```
   probe: Solis → maybe（score=2）
   • ソリス・レコード [organization] w=4.1109 → sekai_term
   ```

### 4.8 其余消费面

| 改动 | 依据 |
| --- | --- |
| `term_lookup` 透出 `tag` / `sort` | 端点新增参数（上游 `Param("tag"/"sort")`）；`compactTerm` 输出 `tags=` / `weight=` / `occ=` / `未认证语言=` |
| `web_lookup` 透出 `include_text` / `max_text_chars` | 端点既有参数，0.2.x 刻意未透出；现按需索取（默认关闭，不破坏 token 预算） |
| `news` 输出 `count` / `information_type` | 实测响应新增 `count`/`available`/`sources` 与 `information_type` |
| `status` 增加 `progress` + `data_gaps` + 词表状态 | `/progress`（6–11 ms）与 `/data_gaps`（2 ms）都是毫秒级；`progress` 已按「只计源站确实提供的内容」口径给出 98%，比旧口径更如实 |
| `resolve` 中文变体回退 | 见 §4.9 |
| 结果缓存 TTL 表补 `term_penetrate`(10 min)/`news`(2 min)/`progress`/`data_gaps` | `term_penetrate` 是最贵的查询之一，必须缓存 |
| `config` 支持 profile 行覆盖 | 见 §4.10 |

### 4.9 `resolve` 的中文变体：如实回退，不静默改写

上游 `tools.py` 的默认 `target_language` 是 `zh_tw`，但 v3 store 的实体名与
译名槽用 `zh_hant`。实测：

```
resolve?query=Ichika&target_language=zh_tw  → target_name=null, translation_status=missing
resolve?query=Ichika&target_language=zh_hant → target_name="星乃一歌", available
```

两种做法都不可取：静默把 `zh_tw` 改写成 `zh_hant` 会抹掉「上游确实没这个语言」
这一信息；照原样返回则让上游自己的默认值永远返回空。

0.3.0 的做法：**先按调用方给的语言如实查询**；仅当整批结果都是「未覆盖」时，
才用变体重试一次；命中则在结果里显式标注实际语言：

```
（target_language=zh_tw 全部未覆盖，已按 zh_hant 重试并命中）
• character:1 [character] HOSHINO ICHIKA → 星乃一歌（official=true trust=A score=100）
```

这样「键名不一致」与「上游未覆盖」两种情况可区分，且 `sanitizeParams`
不再改写任何语言键（`compactResolve` 原有的 `未覆盖（规范名 …）` 分支保持有效）。

### 4.10 配置：接入 `apply(ctx, config)`

0.1.7 的插件契约是 `apply(ctx, config)`，行 `config` 经 Cordis
`resolveConfig` 校验后传入。本插件**不声明 `Config`**（那需要
`import '@deepseek-ai/schemastery'`，与 §3.2 同一个解析失败问题），
改为在 `apply` 里接收行 config，效果等价：

```yaml
- id: dsh-sekaisync-connect
  name: 'dsh-sekaisync-connect'
  config:
    store: 'D:\sekaisync\store'
    python: 'py'
```

优先级：**环境变量 > profile 行 config > `SEKAISYNC_CONFIG` > `config.json` > 自动发现**。
已实测行 config 真正生效（`verify-activation.mjs` 断言
`loadConfig().store === row.store`）。

---

## 五、验证

### 5.1 静态契约

```
$ node scripts/audit-timeouts.mjs
tool                 outer    inner   margin   verdict
sekai_probe           3000      n/a      n/a   pure-local (no HTTP)
sekai_lookup        150000   140000    10000   OK
sekai_fact          120000   110000    10000   OK
sekai_resolve       120000   110000    10000   OK
sekai_term          120000   110000    10000   OK
sekai_penetrate     200000   190000    10000   OK
sekai_alias         150000   140000    10000   OK
sekai_web           260000   250000    10000   OK
sekai_news          120000   110000    10000   OK
sekai_status        180000   170000    10000   OK
→ all 10 tools: outer budget > inner abort budget
```

`audit-timeouts.mjs` 现在直接读 `index.js` 导出的 `BUDGETS`（不再用正则解析源码），
并做**反向断言**：若存在映射到未知工具的孤儿预算就报错——改工具名时不会静默漏检。

10/10 工具 schema 通过 `assertSupportedJsonSchema`（用 DSH 自己的校验器调用），
且根 `type=object`、`required ⊆ properties`、必填项不带 `default`：

```
OK   sekai_probe        props=1 req=1 timeout=3000
OK   sekai_lookup       props=5 req=1 timeout=150000
OK   sekai_fact         props=2 req=1 timeout=120000
OK   sekai_resolve      props=4 req=1 timeout=120000
OK   sekai_term         props=5 req=1 timeout=120000
OK   sekai_penetrate    props=3 req=1 timeout=200000
OK   sekai_alias        props=2 req=1 timeout=150000
OK   sekai_web          props=7 req=1 timeout=260000
OK   sekai_news         props=4 req=0 timeout=120000
OK   sekai_status       props=0 req=0 timeout=180000
→ ALL 10 TOOL SCHEMAS PASS
```

### 5.2 进程内装配（**真实 0.1.7-rc.2** 注册表）

`scripts/verify-activation.mjs` 默认定位 `app.asar`、按正确偏移抽取其中的
`dsh/node_modules`，再用**本环境实际运行的**那份 `@deepseek-ai/dsh-tools`
（`ToolRuntime` 服务）+ `@deepseek-ai/cordis` 挂载本插件，
走真实 `ctx.plugin(..., row)` 与 `tools.execute()` 派发。
脚本会先打印被测运行时版本（避免再次测错版本）：

```
extracted 12318 files from dsh/node_modules -> C:\…\dsh-runtime-BYqzO5\node_modules
runtime: @deepseek-ai/dsh-tools 0.1.7-rc.2 @ C:\…\dsh-runtime-BYqzO5\node_modules
visible sekai_* tools: 10/10
  sekai_probe       props=1   req=["query"]
  sekai_lookup      props=5   req=["query"]
  sekai_fact        props=2   req=["entity_id"]
  sekai_resolve     props=4   req=["query"]
  sekai_term        props=5   req=["query"]
  sekai_penetrate   props=3   req=["query"]
  sekai_alias       props=2   req=["query"]
  sekai_web         props=7   req=["query"]
  sekai_news        props=4   req=[]
  sekai_status      props=0   req=[]
render() contracts: 10/10 OK
isConcurrencySafe: sekai_probe=true sekai_web=false
config from row applied: store=C:\dsh_projects\sekaisync-handoff-2026-08-14\store
dispatch sekai_probe -> probe: ネットパラダイス → maybe（score=1，词表来源=static）…
missing-required arg -> ERROR: 缺少必填参数 query——…
→ ACTIVATION OK on dsh-tools 0.1.7-rc.2 (schemas+render+config+concurrency+dispatch+argguards)
```

### 5.3 端到端（自管子进程，21/21）

`scripts/verify-017.mjs`，覆盖 0.4.0-alpha 全部消费面：

```
=== 1. 契约与本地逻辑（零 HTTP）===
PASS    1663ms  lexicon warmup (terms export)          source=terms_export terms=9190
PASS       2ms  probe 跨作品门控 (初音ミク → 非 yes)
PASS       2ms  probe 上游指南 §4 用例 (event+location → penetrate)
PASS       2ms  probe 非世界计划内容 → no
PASS       0ms  sanitizeParams 收敛 P15 边界
PASS   11028ms  resolve 中文变体回退
PASS       1ms  取消信号：已中止的 signal 立即结束调用
=== 2. 端到端 ===
PASS    2289ms  lookup 星乃一歌
PASS      12ms  fact_pack character:1
PASS       0ms  resolve Ichika (zh_hant)
PASS       0ms  resolve 覆盖声明 (zh_tw → missing 如实标注)
PASS     133ms  term_lookup ネットパラダイス (tags/weight)
PASS      15ms  term_lookup tag 过滤 (tag=person 命中 0 属预期)
PASS   71231ms  term_penetrate 跨语言穿透（含 missing 如实声明）
PASS    1422ms  resolveAlias khn3 (box)
PASS     603ms  resolveAlias wl3 (wl round)
PASS      10ms  resolveAlias 官方箱活名
PASS      85ms  news ja/event（count/matched/正文标记）
PASS      79ms  news body=false（三态过滤）
PASS  113677ms  web_lookup include_text
PASS    9595ms  status（freshness + progress + gaps + lexicon）
=== RESULT: 21 passed, 0 failed ===
```

`scripts/smoke.mjs` 同样通过（覆盖同一批端点，含 `activity(khn3/wl3)` 与官方箱活名）。

---

## 六、复现方式

```powershell
# 静态契约
node scripts/audit-timeouts.mjs
node scripts/verify-activation.mjs      # 进程内真实注册表装配
node scripts/verify-plugin-entry.mjs    # 新插件入口的展示元数据（title/description/icon）
node scripts/verify-entry-exports.mjs   # exports 子路径可解析性（含横向对比）
node scripts/verify-entry-compat.mjs <semver包路径>   # 兼容性闸门逐版本放行判定
# 端到端（自动拉起 sekaisync 子进程）
node scripts/verify-017.mjs
node scripts/smoke.mjs
```

> `verify-entry-compat.mjs` 需要 semver 包路径，因为它复刻的是 DSH 自己的
> `evaluatePluginCompatibility`。本机可用：
>
> ```powershell
> $sm = (Get-ChildItem "$env:LOCALAPPDATA\..\..\GreenApps\DeepSeekHarness-Desktop\harness-rc2\node_modules\.pnpm" `
>   -Directory -Filter 'semver@7.8.5' | Select-Object -First 1).FullName + '\node_modules\semver'
> ```
>
> 或改用 profile 内任意可解析到的 semver 副本。

读取 0.1.7-rc.2 的 asar（本文件 §1 的核查手段）——**用现成脚本，别手写偏移**：

```powershell
# 抽取 app.asar 内的 dsh 运行时到临时目录（脚本会自检偏移并在算错时报错）
node scripts/extract-asar-runtime.mjs `
  "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar" `
  "$env:TEMP\dsh-runtime\node_modules"
```

若要自己写，注意 Pickle 布局与那个**差 2 字节**的陷阱：

```js
const fd = readFileSync(asarPath)
const jsonSize = fd.readUInt32LE(12)
// 目录 JSON 在 [16, 16 + jsonSize)
const header = JSON.parse(fd.subarray(16, 16 + jsonSize).toString('utf8'))
// ⚠️ 数据段起点必须是 align4(8 + u32(4))，不是 16 + jsonSize（后者少 2 字节）
const dataStart = (8 + fd.readUInt32LE(4) + 3) & ~3
// walk(header) → { path, offset, size }；单文件 = fd.subarray(dataStart + offset, … + size)
//
// 抽完务必自检：把已知为 JSON 的文件（如 …/dsh-tools/package.json）解析一次，
// 失败就说明偏移算错了。这个自检已内建在 extract-asar-runtime.mjs 里。
```

---

## 七、仍待关注

1. **`web_lookup` 仍是唯一的分钟级工具**（本次实测 41–142 s，抖动很大）。
   上游 0.4.0-alpha 的发布说明称 `web_search` 已 163.6 s → 0.18 s，
   但那是**带选择性过滤**的快速路径；本插件发出的宽泛查询仍回退全量扫描。
   内层 250 s / 外层 260 s 继续覆盖，缓存 10 分钟。
   → 若后续要压低，应在上游把「宽泛查询」也纳入候选索引，而非继续抬预算。
2. **`term_penetrate` 42–99 s 且经常整个语言 `missing`**。
   成本来自 `load_pages` 全量加载（与 `web_lookup` 同源）。
   本版已缓存 10 分钟；但若上游能把穿透限定在已加载的 story 上，收益更大。
3. **`facts` 的逐区服能力尚未透出**。`core.fact_pack` 有 `region` / `as_of`，
   但 HTTP 路由**没有声明**这两个参数，`coerce_args` 只读 `spec.args`，
   所以传了会被**静默忽略**。本版因此**不暴露**它们（隐藏一个假参数比暴露更糟）；
   等上游把 `region`/`as_of` 加到 `fact_pack` 的 ToolSpec 后再透出。
4. **`web_lookup` 的 `zh_tw` 语言键**：实测 `language=zh_tw` 命中 0 而
   `zh_hant` 也命中 0（该查询本身在本 store 无中文行），暂无法判定是否为同类
   键名不一致；已按「不改写、如实返回」处理，待有中文剧情样本时复验。
5. **本插件尚未挂进当前（desktop）profile**。宿主是 0.1.7-rc.2，但
   `dsh-sekaisync-connect` 目前只装配在 **web** profile 的 `dsh.profile.bundles` 里；
   desktop profile 的 bundles 只有 `dsh-base` / `dsh-web-app` / `dsh-zgit`。
   因此本会话的工具表里看不到 `sekai_*` 工具——这不是插件缺陷，而是它没被这个
   profile 选中。要在本环境实际使用（并看到 Web 侧边栏 **Plugins** 页里的条目），
   需把插件加进 desktop profile：

   ```powershell
   dsh plugin --profile desktop add C:\dsh_projects\dsh-sekaisync-connect
   ```

   或在该 profile 的 `package.json` 里加 `"dsh-sekaisync-connect": "link:C:/dsh_projects/dsh-sekaisync-connect"`
   并追加到 `dsh.profile.bundles`。
   （本轮不改 profile：改动会影响该 profile 的每一个会话，应由使用者决定。）
6. **本版只用两版共有的 API**（`register` / `output` / `timeoutMs` /
   `exec.signal` / `isConcurrencySafe` / `ctx.effect`），因此对 0.1.5-rc.2 与
   0.1.7-rc.2 都成立；`deferLoading`、`ptcRuntime` 等 0.1.7 专有面均未触及。
   **注意**：装配验证已改为默认对着 `app.asar`（真实 0.1.7-rc.2）运行，
   见 §1.1。
