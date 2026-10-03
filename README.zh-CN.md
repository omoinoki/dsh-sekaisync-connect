<!-- readme-brand:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/header-dark.svg">
  <img src=".github/readme/header-light.svg" alt="" width="1280">
</picture>
<!-- readme-brand:end -->

# SekaiSync Connect for DeepSeek Harness

[English](README.md) | 中文

[![Release](https://img.shields.io/badge/Release-0.3.9--alpha.1-006F78?style=flat&labelColor=17263B)](package.json) [![Runtime](https://img.shields.io/badge/Runtime-Node.js%2020%2B-4F6175?style=flat&labelColor=17263B)](package.json) [![Platform](https://img.shields.io/badge/Platform-Cross--platform-4F6175?style=flat&labelColor=17263B)](package.json) [![License](https://img.shields.io/badge/License-MIT-AC246D?style=flat&labelColor=17263B)](LICENSE)

<!-- readme-navigation:start -->
<p>
  <a href="#readme-overview">项目介绍</a> ·
  <a href="#readme-section-01">快速开始</a> ·
  <a href="#readme-section-03">配置</a> ·
  <a href="#readme-section-panel">插件面板</a> ·
  <a href="#readme-section-tools">工具一览</a> ·
  <a href="#readme-section-08">使用建议</a> ·
  <a href="#readme-section-09">更多说明</a>
</p>
<!-- readme-navigation:end -->

<a id="readme-overview"></a>

SekaiSync 知识库的 **DeepSeek Harness 直连插件**：具备无第三方依赖、免构建流程与低 Token 消耗特性，并在插件面板中提供部署路径选择。

<a id="readme-section-01"></a>

## 安装

环境要求：**Python ≥ 3.10** 且可 `python -m sekaisync`（零第三方依赖），以及一个已同步的
store（`sekaisync init` / `sync` 产物）。

```powershell
# 从 Git 安装本版本：
dsh plugin --profile web add github:omoinoki/dsh-sekaisync-connect#v0.3.9-alpha.1

# 或从本地检出的目录安装：
dsh plugin --profile web add ./dsh-sekaisync-connect
```

项目主页：<https://github.com/omoinoki/dsh-sekaisync-connect>

| 运行时 | 判定 |
| --- | --- |
| `0.1.x` | **DENY**——本插件所需的面板接口在 `0.2.0-rc.1` 之前不存在 |
| `0.2.0-rc.1` | allow（已实测：工具、面板与真实查询都在该运行时上跑通） |
| `0.2.0-rc.2` | allow（已验证真实 Web profile、部署面板、工具执行及区服事实） |
| `0.2.x` | allow |
| `0.3.0` / `0.3.0-rc.1` / `1.0.0` | **DENY**——未验证的版本一律拒绝 |

不在放行范围内的版本会被整体拒绝，而不是半加载：最坏情况是一条清楚的「不兼容」提示，
而不是崩溃。确实要在未验证版本上运行时，用 `dsh plugin allow-version`。

若某次运行时升级把本插件禁用了，症状是工具整体消失、面板也不加载：整个组合包在插件代码
运行**之前**就被拒掉了。

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
- id: sekaisync-connect
  name: 'dsh-sekaisync-connect'
  config:
    store: 'D:\\sekaisync\\store'
    python: 'py'
```

请保留行的 `id` 为 `sekaisync-connect`。它是面板写入所用的键；若把这段示例复制进仍在用旧 id
的 profile，请把那一行的 id 一并改过来，否则面板与已保存的路径会指向不同的行。

- HTTP 仅连接回环地址（loopback），显式禁止重定向。健康探测与错误响应分别限制为 64 KiB 与 4 KiB。默认常规响应预算为 128 MiB，覆盖常规 `limit=100` 与 `max_text_chars=200000` 的正文结果。`max_text_chars=0` 仍表示获取上游全量正文；若超大正文超出传输预算，可通过增大 `maxResponseBytes`（上限 1 GiB）或采取分批检索的方式处理。
- 外部端口复用依然依赖 `/health` 的 ready/status 判定；因该端点未携带 store 唯一标识，配置时请确保对应端口指向正确的知识库实例。

<a id="readme-section-panel"></a>

## 在插件面板中选择部署路径

当 profile 提供 Web 客户端时，本插件会在侧边栏 **插件** 页的自有行上多出一个 **配置** 页面，用来在图形界面里选择 SekaiSync 部署路径，不必手改 JSON。

打开 **插件 → 已安装 → dsh-sekaisync-connect → 该行的「配置」**，页面提供：

| 控件 | 作用 |
| --- | --- |
| 路径输入框 + **检查** | 判定该路径是 store、仓库根还是 `kb/` 目录，并给出数据库体积、`kb/` 条目数，以及存在时的 `freshness` 内容 |
| **保存并生效** | 校验路径后，经官方 `settings` 服务持久化到 profile 的 `cordis.patch.yml` 并即时生效——「生效 store / 生效 root」当场更新，无需重启 DSH |
| **测试连接** | 对选定的部署真实发起一次 `/health` 请求，报告延迟与就绪状态 |

**生效 store / 生效 root** 会随输入框的路径实时更新（250ms 去抖）；当输入的路径与已保存的
不一致时，上方会显示**「尚未保存」**标记——改动在提交之前就看得见。

store 可以独立于源码仓库部署。数据目录旁没有 SekaiSync 源码证据时，面板会保留已配置的
`root`，不会用数据目录的父目录覆盖它。识别到真实源码仓库时可以选择新的根目录；
没有既有 `root` 时，父目录仅作为已安装 Python 包场景下明确标注为未验证的回退，
请用**测试连接**检查所选部署。

面板读写的是插件自己的 **Cordis Config**（`store` / `root`），改动在升级后依然保留，且无需重启 DSH 即生效。显示的值是运行时按完整优先级链解析后的结果：环境变量 > profile 行 config > `SEKAISYNC_CONFIG` > `config.local.json` > `config.json` > 自动发现。

刻意的边界：

- 面板只写 `store` 与 `root` 两个字段，且必须通过路径分类之后才经官方 `settings` 服务落盘。`python` **刻意不允许**从面板修改：把一个可执行文件路径暴露在 HTTP 上，等于把「任意程序执行」搬到网页上。面板写入最坏的结果只是把知识库指向另一个目录。
- 面板**不提供**自动探测、选择文件夹与目录浏览。这三个动作依赖宿主侧的目录级权限，而插件行无法
  可靠地拿到这些权限；与其留几个按下去没反应的按钮，不如删掉。路径请直接输入，`Check` 会判定它
  到底是什么。
- 面板后端是一个 **Typert Remote** 服务（命名空间 `sekaisync`），注册在本 profile 行自己的 fiber 里，与官方 `dsh-experimental-voice-input-bundle` / `dsh-api-settings-controller` 的做法一致。写入走 `settings.update`，由框架用与所有 `/api` 表面相同的 Host/Origin + cookie 栅栏把关，并串行化写入、写入前先校验取值。没有 `settings` 服务的组合（纯 CLI）不会挂载面板，而 10 个工具照常可用。
- 面板是增强项而非必需项。没有它时，上面的文件配置方式完全照旧可用。

<a id="readme-section-tools"></a>

## 工具一览

十个面向模型的工具，对本地知识库均为只读：

| 工具 | 耗时量级 | 用途 |
| --- | --- | --- |
| `sekai_probe` | ~1 ms | 判定话题是否属于《世界计划》；返回 `verdict` 与建议的下一个工具 |
| `sekai_lookup` | ~2.3 s | 任意语言名称匹配实体（角色/活动/卡片/卡池/曲目/区域），含跨服名称与活动简称解析 |
| `sekai_fact` | ~5 ms | 按实体 id 取紧凑事实包（如 `character:1`、`card:123`）——取结构化事实最省的方式 |
| `sekai_resolve` | ~1 s | 把专有名词解析为官方本地化名称；如实报告 `translation_status`，不留空 |
| `sekai_term` | ~150 ms | 游戏内用语与跨语言译名，含 tags、weight 与出处证据句 |
| `sekai_penetrate` | 40–100 s | 单一点位上的用语跨语言穿透，逐语言对齐原文 |
| `sekai_alias` | ~1.3 s | 解析活动简称（`khn3`、`wl3`）与官方活动名，支持自然问句 |
| `sekai_web` | 40–160 s | 已爬取剧情全文检索；需要引用原文时使用 |
| `sekai_news` | ~80 ms | 五服官方公告，可按语言、分类与正文可用性过滤 |
| `sekai_status` | 6–33 s | 知识库就绪状态、数据新鲜度、各服覆盖与同步率 |

<a id="readme-section-08"></a>

## 区服事实与正文缺口

store 与源码仓库分开存放时，检查或保存路径会保留当前后端 root，除非新位置
包含实际 SekaiSync 源码。此前没有 root 的安装包部署仍可使用数据父目录回退，
但会明确标记为未经源码验证，不把它当成已确认的源码仓库。

`sekai_fact` 支持可选 `region`（`jp`、`en`、`tc`、`kr`、`cn`）。例如，
在希望使用英文的同时，明确请求日服快照：

```json
{"entity_id":"character_profile:18","language":"en","region":"jp"}
```

结果会披露实际区服与正文语言，指定区服时不会借用其他区服正文。这个工具也接受
`zh_tw` 作为 `zh_hant` 的别名，以及 `zh_cn` 作为 `zh_hans` 的别名。
显式区服请求要求后端确认请求范围；旧后端静默忽略参数时，会明确提示升级，
不会把未过滤的结果当作指定区服事实。

正文缺失或需要指定区服是数据状态，不代表已经取得完整档案。提示会放在正文之前；
如需区服，应从列出的可用区服中选择一个重试。未限定区服的实体检索会把区域证据
与共同事实分开呈现。

缺参数、HTTP 请求失败、进程启动失败和取消会以工具错误报告，不再伪装成普通的
成功 `ERROR:` 字符串。

升级 SekaiSync 后端代码不会自动恢复旧数据库已经丢弃的字段。应按后端恢复说明
重启旧服务，并从 raw 重新同步或重建，再验证正文是否恢复。

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

- `未找到 sekaisync 知识库 store`：设置 `SEKAISYNC_STORE` 或改 `config.json`。
- `无法启动 python …`：确认 `python -m sekaisync --help` 可用；缺包时 `pip install -e <sekaisync 仓库>`。
- 服务器 60 秒冷却：连续崩溃 2 次后暂停自动重启，检查 store 完整性（`python -m sekaisync --no-event-check integrity`）。
- 失败工具结果里的 `HTTP ...`：服务器已起但请求失败，多为参数问题；`sekai_status` 可看服务模式与 store 路径。
- `缺少必填参数 ...`：插件侧守卫拦截，按提示补齐参数即可。
- 行上找不到「**配置**」入口：面板需要带插件管理界面与 `settings` 服务的 Web profile（纯 CLI 组合两者皆无）。请确认 profile 里有 `ui-plugin-manager`、该组合包已开启，且部署路径可被解析（见第一条）。
- 「**保存并生效**」提示成功但路径没变：更高层（环境变量或 profile 行 config）已钉死 `store`。页面会显示当前生效值，请改那一层。
- 面板返回 `forbidden` 或 `unauthorized`：请求没有通过框架的 Host/Origin 与 cookie 栅栏。面板基于 `settings` 的写入刻意只对已鉴权的本机客户端开放。
- `sekai_probe` 显示 `词表来源=static`：动态词表（`terms export`）尚未预热完成或构建失败，
  探针已退化为内置静态词库；稍后重试或检查 store 完整性。
