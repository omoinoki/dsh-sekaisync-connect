<!-- readme-brand:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/header-dark.svg">
  <img src=".github/readme/header-light.svg" alt="" width="1280">
</picture>
<!-- readme-brand:end -->

# SekaiSync Connect for DeepSeek Harness

[English](README.md) | 中文

[![Release](https://img.shields.io/badge/Release-0.3.2--alpha-006F78?style=flat&labelColor=17263B)](package.json) [![Runtime](https://img.shields.io/badge/Runtime-Node.js%2020%2B-4F6175?style=flat&labelColor=17263B)](package.json) [![Platform](https://img.shields.io/badge/Platform-Cross--platform-4F6175?style=flat&labelColor=17263B)](package.json) [![License](https://img.shields.io/badge/License-MIT-AC246D?style=flat&labelColor=17263B)](LICENSE)

<!-- readme-navigation:start -->
<p>
  <a href="#readme-overview">项目介绍</a> ·
  <a href="#readme-section-01">快速开始</a> ·
  <a href="#readme-section-09">更多说明</a>
</p>
<!-- readme-navigation:end -->

<a id="readme-overview"></a>

SekaiSync 知识库的 **DeepSeek Harness 直连插件**：具备无第三方依赖、免构建流程与低 Token 消耗特性。

<a id="readme-section-01"></a>

## 安装

```powershell
# 环境要求：Python ≥ 3.10 且可 `python -m sekaisync`（零第三方依赖），
# 以及一个已同步的 store（sekaisync init / sync 产物）。

# 常规插件装配（bundle patch，DSH 官方机制）
dsh plugin --profile web add <本目录>
```

| 运行时 | 判定 |
| --- | --- |
| `0.1.5-rc.2` | allow |
| `0.1.7-rc.2` | allow |
| `0.1.8` | allow |
| `0.2.0-rc.1` / `0.2.0` | **DENY**（未验证的版本 fail-closed，用 `dsh plugin allow-version` 豁免） |

<a id="readme-section-03"></a>

## 配置

配置项优先级：**环境变量 > profile 行 config > `SEKAISYNC_CONFIG` 文件 > 插件目录 `config.local.json` > `config.json` > 自动发现**。

| 配置项 | 说明 |
| --- | --- |
| `SEKAISYNC_STORE` | 指定知识库 store 目录路径（包含 `kb/`）。缺省时按以下顺序查找：`<SEKAISYNC_ROOT>/store`、当前工作目录下的 `store`、以及通过 `python -c "import sekaisync"` 定位到的仓库中的 store 目录 |
| `SEKAISYNC_ROOT` | SekaiSync 仓库根目录（即执行 `python -m sekaisync` 的工作目录） |
| `SEKAISYNC_PYTHON` | Python 可执行文件路径，默认值为 `python` |
| `SEKAISYNC_PORT` | 复用已有服务的探测端口，默认值为 8787。若该端口已有处于就绪状态的 SekaiSync 服务，则直接复用而不启动新进程；设为 0 表示跳过外部探测，直接启动托管服务 |
| `SEKAISYNC_MAX_RESPONSE_BYTES` | 单次 HTTP 成功响应的字节预算，默认值为 134217728（128 MiB），有效范围为 65536–1073741824。亦可在配置文件或 profile 中设置 `maxResponseBytes`。超出预算将中止读取并返回明确错误 |

亦可在 profile 的 patch 配置中进行覆盖，该配置在插件更新时不会被覆盖：

```yaml
- id: dsh-sekaisync-connect
  name: 'dsh-sekaisync-connect'
  config:
    store: 'D:\\sekaisync\\store'
    python: 'py'
```

- HTTP 仅连接回环地址（loopback），显式禁止重定向。健康探测与错误响应分别限制为 64 KiB 与 4 KiB。默认常规响应预算为 128 MiB，覆盖常规 `limit=100` 与 `max_text_chars=200000` 的正文结果。`max_text_chars=0` 仍表示获取上游全量正文；若超大正文超出传输预算，可通过增大 `maxResponseBytes`（上限 1 GiB）或采取分批检索的方式处理。
- 外部端口复用依然依赖 `/health` 的 ready/status 判定；因该端点未携带 store 唯一标识，配置时请确保对应端口指向正确的知识库实例。

<a id="readme-section-08"></a>

## 使用建议（token 纪律）

1. 生成任何本地化文本前先 `sekai_resolve`；需要精确事实用 `sekai_fact`；别让模型凭记忆回答。
2. 陌生名词/来源不明的角色名/不确定话题，先 `sekai_probe` 判定是不是世界计划内容，再决定走本地工具还是 web。命中项直接给出建议的 `next_tool`。
3. 时效性问题（当前活动/卡池/维护）先 `sekai_status` 看新鲜度与覆盖率。
4. 核对某个译名在具体语境里的用词：`sekai_term` 确证用语存在 → `sekai_penetrate` 看各语言对应行。注意 `missing` 是「该语言没有对应行」的如实声明，不是错误。
5. `sekai_web` 很慢，只在引用剧情原文时用；先试 `sekai_lookup` / `sekai_term`，或先 `sekai_probe` 确认方向。
6. 活动简称或箱活名（箱活或 World Link）直接问即可：`sekai_lookup` 会自动附带活动解析，`sekai_alias` 支持简称/官方箱活名/自然问句。
7. 结果被截断时缩小 `limit` 或换更精确的查询词。

<a id="readme-section-09"></a>

## 故障排查

- `ERROR: 未找到 sekaisync 知识库 store`：设置 `SEKAISYNC_STORE` 或改 `config.json`。
- `ERROR: 无法启动 python …`：确认 `python -m sekaisync --help` 可用；缺包时 `pip install -e <sekaisync 仓库>`。
- 服务器 60 秒冷却：连续崩溃 2 次后暂停自动重启，检查 store 完整性（`python -m sekaisync --no-event-check integrity`）。
- 工具结果里的 `ERROR: HTTP …`：服务器已起但请求失败，多为参数问题；`sekai_status` 可看服务模式与 store 路径。
- `ERROR: 缺少必填参数 …`：插件侧守卫拦截，按提示补齐参数即可。
- `sekai_probe` 显示 `词表来源=static`：动态词表（`terms export`）尚未预热完成或构建失败，
  探针已退化为内置静态词库；稍后重试或检查 store 完整性。
