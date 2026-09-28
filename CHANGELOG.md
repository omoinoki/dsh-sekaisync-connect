# Changelog

本文件记录每个版本的对外可见变化。适配依据与逐项实测见
[`VERIFY-0.3.0.md`](./VERIFY-0.3.0.md) 与 [`VERIFY-0.4.0-alpha.md`](./VERIFY-0.4.0-alpha.md)。

## 0.3.1

**修正两处校验错误 + 接入兼容性闸门（无工具 API 变化）**

1. **修正 asar 抽取偏移（方法论缺陷）**：原用 `16 + u32(12)`，比正确的
   `align4(8 + u32(4))` **少 2 字节**，使每个抽出的文件头部多 2 个垃圾字符、
   尾部少 2 字节。后果是装配验证实际测的是 `profiles/node_modules` 那份
   **0.1.5-rc.2**，而非本环境真实运行的 **0.1.7-rc.2**。
   - 新增 `scripts/extract-asar-runtime.mjs`：正确偏移 + **自检**
     （抽完立刻解析已知 JSON 文件，偏移算错即报错退出）。
   - `scripts/verify-activation.mjs` 改为默认定位 `app.asar` 并对着它装配，
     **打印被测运行时版本**；找不到 asar 时才退回 junction 并显式告警。
   - 用修正后的数据**复核全部既有结论**（`register` 不校验 arguments、
     `timeoutMs` 仅声明、`deferLoading` 在 pi-ai 抛错、`codeRuntime`→`ptcRuntime`
     改名、`manifest.meta` 零引用、preflight 读 `peerDependencies`、`iconOf` 校验）
     ——均成立；10/10 工具在真实 0.1.7-rc.2 上装配通过。

2. **修正兼容性声明的错误结论，改为声明 `peerDependencies`**：
   早期版本曾断言「没有一条 semver 范围能同时覆盖 0.1.5-rc.2 与 0.1.7-rc.2」，
   并据此两类字段都不声明。该断言用的是 semver **默认**语义，
   而组合期闸门 `evaluatePluginCompatibility` 带 `{ includePrerelease: true }`——
   语义不同。在闸门语义下 `^0.1.5-rc.2` 即覆盖全部 0.1.x（含 prerelease）
   并拒绝 0.2.x。
   - 现在声明 `@deepseek-ai/dsh-tools: ^0.1.5-rc.2` 与 `@deepseek-ai/cordis: ^4.0.2`，
     让闸门真正生效：0.1.5-rc.2 / 0.1.7-rc.2 / 0.1.8 放行，
     未验证的 0.2.x **fail-closed**（可用 `dsh plugin allow-version` 豁免）。
   - 已实测排除「装出第二份 harness」的风险：pnpm 11 在 `link:` 与 registry
     两种安装下都不拉取这些 peer；真实 profile 里同样声明了 harness peer 的
     `dsh-zgit` 也没有把 `@deepseek-ai` 装进来。
   - 澄清误读：技能文档说的「bundle declares no **dependencies** on them」
     约束的是 `dependencies`，不是 `peerDependencies`。
   - `engines.dsh` 仍不声明（manifest 文档明确该字段不被强制检查）。

3. 新增 `CHANGELOG.md`；文档更正环境事实（本环境**就是** 0.1.7-rc.2）
   与「插件尚未挂进 desktop profile」这一现状。

## 0.3.0

**适配 DSH V0.1.7-rc.2 与 SekaiSync 0.4.0-alpha**

DSH V0.1.7-rc.2：

- `exec.signal` 协作式取消真正接线：取消立即中止 HTTP fetch、不重试，
  并返回「已取消」而非误报「超时」。
- `isConcurrencySafe` 按实测成本分类：毫秒级端点（probe/fact/resolve/term/
  news/status）可并行，重查询（lookup/penetrate/alias/web）独占。
- `timeoutMs` 明确为声明（由 `dsh-tool-call-timeout-policy` 执行）：
  外层预算恒比内层 fetch 预算多 10 s，`audit-timeouts.mjs` 断言并检测孤儿预算。
- 补插件侧参数守卫（`register()` 路径不校验 arguments，缺参会拿到上游 HTTP 400）。
- 接入 `apply(ctx, config)`，支持在 profile 的 `cordis.patch.yml` 覆盖配置。
- **新增独立插件入口的元数据契约**：`locale/{en,zh}.json` 提供本地化标题/描述
  （`package.json` 顶层 `meta` 不会被读取）、`exports` 必须导出
  `"./package.json"` 与 `"./locale/*.json"`、新增严格校验的包内 `icon.svg`。
  刻意不声明 `engines.dsh`（不被强制检查，且 semver 无法用一条范围同时覆盖
  0.1.5-rc.2 与 0.1.7-rc.2）与 harness `peerDependencies`（官方约定：
  随 dsh 出货的包由 dsh 安装解析）。
- 刻意不使用 `deferLoading`（会隐藏工具，且 `llm-pi-ai` 抛 `UNSUPPORTED_CONTENT`）
  与 `defineTool()`（插件是 profile 外部 link 包，解析不到 harness 内置包）。

SekaiSync 0.4.0-alpha：

- 新增第 10 个工具 `sekai_penetrate`（同点位跨语言穿透）；`missing` 作为
  「该语言无对应行」如实声明，不丢弃也不伪装为空。
- `sekai_probe` 的静态热词数组改为**启动时从 store 构建的动态词表**
  （`terms export`，9190 条），命中项带 `tags`/`weight`/`next_tool`；
  实现跨作品门控（`初音ミク`/`MEIKO` 不再单独判 yes）与前缀命中
  （`Solis` → `ソリス・レコード`）。
- `sekai_term` 透出 `tag`/`sort`，输出 `tags`/`weight`/`occ`/未认证语言。
- `sekai_web` 透出 `include_text`/`max_text_chars`（默认关闭）。
- `sekai_news` 输出总条数与 `information_type`。
- `sekai_status` 增加同步率（只计源站确实提供的内容）与 `source_unavailable`、
  `data_gaps`、词表状态。
- `sanitizeParams()` 前置收敛 P15 参数边界（`limit≤100`、`query≤2048`），
  把「参数越界」变成一次成功调用。
- `resolve` 中文变体**如实回退**：先按调用方语言查询，整批未覆盖时才用
  `zh_hant` 重试一次并标注实际语言（不静默改写）。

同时修正两处既有缺陷：

- `regions` 参数形状不匹配（schema 声明 string，内部按 array 处理），
  导致活动解析静默退化。
- 不暴露 `fact_pack` 的 `region`/`as_of`（HTTP 路由未声明，传了会被静默忽略）。

## 0.2.0

- 核查上游 0.4.0-alpha 变动，确认零改动兼容；补充实测性能回归的应对
  （超时预算与健康探测策略），详见 `VERIFY-0.4.0-alpha.md`。

## 0.2.x 及更早

- 9 个工具版本；新增 `sekai_news`（五服官方公告）；存储迁移 SQLite 后
  无需改动即获益。
