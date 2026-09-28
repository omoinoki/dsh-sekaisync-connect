# dsh-sekaisync-connect × sekaisync 0.4.0-alpha 实测核查（2026-09-19）

> **2026-09-20 更新：上游已修复，独立复验通过。**
> 修复提交 `d4cf781`（`fix(core): requests reuse revision-keyed snapshot; /health answers O(1)`）
> 正是针对本文 §3.1 与 §3.3 报告的两个缺陷，其 message 亦引用本插件的
> `scripts/verify-040.mjs`。§六 由修复方撰写，**§八 为插件侧独立复验**（不采信
> §六 数字，重跑探针 + 插件全链路 + 真实 DSH 会话）。原文保留以记录问题全貌。

本文件是 README「2026-09-19 传导核查」一节的**实测复核**。那一节只做了静态比对
（逐项读上游代码/CLI 面），结论是「零改动即兼容」。本次在真实 DSH 会话里跑通了
全部 9 个工具，逐项复核该结论。

**总结论**：**接口面（DSH 契约 + HTTP 端点面）确实零改动兼容**，9 个工具全部注册并可调用；
但**性能面不兼容**——上游重构引入的「每请求全量重载」让 `sekai_lookup` 与 `sekai_web`
稳定超时，其中 `sekai_lookup` 在 DSH 里**已实测失败**。

---

## 一、DSH 侧契约：通过

环境：DSH `0.1.5-rc.2`（`@deepseek-ai/dsh`，profile `web`），
插件经 `dsh.profile.bundles` + `link:` 装配（junction → 本仓库）。

| 契约点 | DSH 0.1.5-rc.2 要求 | 本插件实现 | 结论 |
| --- | --- | --- | --- |
| `ctx.tools.register(def)` | 必须声明 `output { schema, render, presentationMeta? }`；`render` 必须是函数 | `lib/index.js:190` 声明 `output.schema={type:'string'}` + `render` 返回 `ContentBlock[]` | ✅ |
| `output.schema` | 需过 `assertSupportedJsonSchema`（子集：`type/oneOf/properties/required/additionalProperties/items/enum/const` + annotations `description/title/default/examples`） | `{ type: 'string' }` | ✅ |
| `parameters` | 根 `type:'object'`；`required` 中的名字必须都出现在 `properties` | `object()` 构造器（`lib/index.js:27`）满足 | ✅ |
| 属性内 `default` | 属 annotation 关键字，合法 | `strDef/int` 用了 `default`（`lib/index.js:21-22`） | ✅ |
| `timeoutMs` | 正有限数；且**绝不进模型 schema** | 3000 / 30000 / 60000 / 120000，均合法 | ✅ |
| `ctx.effect(() => ...)` 清理 | 支持（含同步 disposer） | `lib/index.js:188,197` | ✅ |
| bundle patch | `package.json.dsh.bundle.patch` + `cordis.patch.yml` 的 `insert` | 二者齐全，`config.json` 同目录 | ✅ |

**实测证据**：本会话工具表里 9 个 `sekai_*` 工具全部可见、可调用，
`sekai_probe` / `sekai_status` / `sekai_fact` / `sekai_resolve` / `sekai_term` /
`sekai_alias` / `sekai_news` / `sekai_web` / `sekai_lookup` 均返回真实数据。

> 说明：README 里「未使用 `ctx.agent` / Inbox / Web plugin panel API，故 0.1.5 breaking
> 不触及」的说法，本次实测复核成立。

## 二、HTTP 端点面：通过

0.4.0-alpha 的 `HTTP_GET_ROUTES`（由 `sekaisync/tools.py` 单一注册表生成）与插件
调用的方法逐一比对，**全部存在**：

```
lookup resolve term_lookup fact_pack freshness news web_lookup event_alias worldlink activity
```
（另含 `term_penetrate refresh tag_clouds data_gaps progress trust integrity verify_claims
events/check events/archive query web_browse status sites`，插件未用。）

响应形状与插件压缩器一致，实测均能正常解析：
- `lookup` → `{query, results[]}`，`compactLookup` 读 `results[].id/type/trust/score/regions/names/facts` ✅
- `fact_pack` → `{text, trust, fact_pack_tokens, raw_json_tokens, token_ratio}` ✅
- `resolve` → `results[].target_name=null` + `translation_status='missing'` + `canonical_name`，
  `compactResolve` 的「未覆盖（规范名 …）」分支实测命中 ✅
- `news` → `{items[].title/published_at/information_tag/body_available/url, matched}` ✅
- `activity` → `kind='box'`（`khn3`）与 `kind=unset`+`round.events[]`（`wl3`）两种形状，
  `compactActivity` 的 `kind==='wl'` 分派正常 ✅
- `freshness` / `status` → `compactStatus` 正常 ✅

参数面：插件发送的 `limit`（8 / 5 / 20）均在 P15 的 `MAX_LIMIT=100` 内；
`body` 只用合法布尔字面量；`callRaw` 过滤空值，不触发 `empty_to_none` 边界 ✅

冷启动实测 **4.3 s**（0.4.0-alpha，含 registry + SQLite 打开），远低于插件的
`START_TIMEOUT_MS=120_000` ✅

## 三、性能面：**不兼容**（本次核查的关键发现）

### 3.1 上游引入的每请求全量重载

`sekaisync/core.py` 在 0.4.0-alpha 给**所有公开查询方法**加了 `request_scoped`
装饰器（`core.py:132-147`）：

```python
def wrapper(self, *args, **kwargs):
    with self.request_view():                       # → load_snapshot()
        return copy.deepcopy(method(self, *args, **kwargs))
```

`request_view()` → `load_snapshot()` → `dbstore.load_entities()` 会**每个请求重新
从 SQLite 载入全部 71,555 个实体**；且 `CoreSnapshot.__getattribute__`
（`core.py:80-82`）在**每次属性访问**时再 deepcopy 整个 registry 元组，
装饰器最后**又 deepcopy 一次返回值**。

本机实测（store `sekaisync-handoff-2026-08-14`，DB 2.26 GB）：

| 内部步骤 | 耗时 |
| --- | --- |
| `dbstore.load_entities` | 2.61 s（71,555 行，993,646 次 `json.loads`） |
| `load_terms_records` | 1.65 s |
| `Core.__init__` | 5.82 s |
| `request_view`（空） | 5.87 s |
| `core.registry`（触发 deepcopy） | 15.92 s |
| `core.lookup` | 25–27 s |
| `core.freshness` | 22.66 s |

`cProfile` 佐证：`core.lookup` 68 s 采样中 **46.6 s 在 `copy.deepcopy`**
（17,098,695 次调用），9.7 s 在 `load_snapshot`。

**这是 0.4.0-alpha 的重构回归**：`0.3.2-alpha` 的 `core.py` 里 `lookup` 是无装饰器
的普通方法，直接读构造期缓存的 `self.registry`，无每请求重载。
（`git log -S 'def load_snapshot'` → `382a09b`，2026-09-17；
`git log -S 'def request_view'` → `9186226`，2026-09-16。）

### 3.2 端点实测 vs 插件声明的 `timeoutMs`

经插件自管子进程（`--port 0` 动态端口）逐端点实测：

| 端点 | 插件 `timeoutMs` | 实测 | 结论 |
| --- | --- | --- | --- |
| `activity` | 60 000 | 1.8 s | ✅ 快（`eventalias` 直读 master JSON，不走 SQL registry） |
| `news` | 30 000 | 5.6 s | ✅ |
| `resolve` | 30 000 | 7.5 s | ✅ |
| `term_lookup` | 30 000 | 8.9 s | ✅ |
| `fact_pack` | 30 000 | 21.1 s | ⚠️ 余量仅 9 s |
| `freshness`（`sekai_status`） | 30 000 | 21.6 s | ⚠️ 余量仅 8 s，冷启动首调曾直接超时 |
| `lookup` | 30 000 | **23–33 s**（4 次连测 28.3/29.9/30.1/30.7 s） | ❌ **越界** |
| `web_lookup` | 120 000 | **127.6 s** | ❌ **越界** |

`lookup` 稳定贴着火线跑，**实测在 DSH 里已经失败**：

```
sekai_lookup(query="星乃一歌", limit=3)
→ Error: tool call timed out after 30000ms        # DSH timeout-policy 兜底
```

同一查询在插件自管服务器上直连 REST 为 25.6–26.3 s——即**成功与否取决于当次抖动**：
`khn3` / `Ichika` 恰好挤进 30 s 内返回，`星乃一歌` 越界。这是最糟的形态：间歇性失败。

CLI 侧同病：`python -m sekaisync lookup --query 星乃一歌` 实测 **36.2 s**，
可确认与插件无关，是上游/store 层面的问题。

### 3.3 更严重的独立缺陷：就绪探测预算（已修）

插件用 **1200 ms / 1500 ms** 探测 `/health`（`probeHealth` 的默认值与调用点）。
但 0.4.0-alpha 的 `/health` 会调用 `core.ready()`（`http_server.py:443`），
而 `ready()` 也是 `@request_scoped` 的 —— **每次健康检查都要重载 + deepcopy
整个 registry**，实测 **21–40 s**。

干净/孤立服务器上的 A/B（各起一个全新服务器，只发一次探测）：

| 探测预算 | 结果 |
| --- | --- |
| 旧 **1500 ms** | FAIL AbortError @ 1502 ms |
| 新 **30000 ms** | **OK** `{"status":"ok","ready":true}` @ 18384 ms |

两个后果：

1. **外部端口复用永久失效**：`ensureServer` 用 1200 ms 探测 `config.json` 的
   `externalPort`(8787)。即使那里已有就绪服务器也**永远探测不到**，
   插件改为自己 spawn 一个副本 —— 于是同一份 store 上出现两个服务器。
2. **就绪循环制造探测风暴**：1500 ms 预算 + 500 ms 间隔、30 s 上限，
   实测在 30 s 内发出 **35 次全部被中止**的探测。Python 无法取消在跑的线程，
   每次中止的探测仍在服务端跑满 ~25 s 并占住
   `MAX_CONCURRENT_REQUESTS=16` 的槽位与 CPU，**反过来饿死真正的查询**：

   ```
   对照（干净服务器）  lookup  Ichika        → 20703ms http=200   ✅
   风暴后（同一服务器）lookup  Ichika        → 90016ms AbortError ❌
   再等 40s 重试       lookup  Ichika        → 90002ms AbortError ❌（未自愈）
   ```

   即：**插件自己的启动探测就会把自己的服务器打成不可用**。
   这也解释了本次测试中反复出现的 `HTTP 503 Server is busy`。

---

## 四、已应用的修复（方案 A + 探测预算）

不改上游，只调插件自己的超时预算。**两层预算必须同步**：外层是 DSH 的
`timeoutMs`，内层是插件 `fetch` 的 abort；只抬外层会让内层照旧提前掐断。
外层统一比内层多 **10 s**，好让插件自己的 `ERROR: … 超时` 先返回，
而不是被 DSH 的通用 tool-timeout 抢先掐掉（两者相等即成为竞态）。

`lib/index.js`（外层 / 内层，单位 ms）：

| 工具 | 旧 | 新 | 实测 |
| --- | --- | --- | --- |
| `sekai_lookup` | 30 000 / 30 000 | **100 000 / 90 000** | 23–38 s |
| `sekai_fact` | 30 000 / 30 000 | **70 000 / 60 000** | 21–36 s |
| `sekai_status` | 30 000 | **70 000** | 21–113 s（含冷启） |
| `sekai_web` | 120 000 / 120 000 | **250 000 / 240 000** | 64–128 s |
| `sekai_resolve` | 30 000 / 30 000 | **45 000 / 35 000** | 7–23 s |
| `sekai_term` | 30 000 / 30 000 | **45 000 / 35 000** | 9–25 s |
| `sekai_news` | 30 000 / 30 000 | **45 000 / 35 000** | 6–22 s |
| `sekai_alias` | 60 000 / 60 000 | **70 000 / 60 000** | 0.7–34 s |
| `sekai_probe` | 3 000 | 3 000（纯本地，无 HTTP） | 即时 |

`lib/backend.js`：

- `PROBE_EXTERNAL_MS = 30_000`（原 1200）—— 恢复外部端口复用
- `PROBE_MANAGED_MS = 60_000`（原 1500）—— 就绪确认给足 `/health` 真实成本
- `MAX_READY_ATTEMPTS = 2` —— **用「少量、每次给足预算」取代密集轮询**，
  从根上消除探测风暴；未确认则响亮报错而不是把一串 503 丢给模型
- `status()` 的 `freshness` 内层预算 30 000 → 60 000，与外层 70 000 对齐

> 说明：`/health` 无服务器时是 instant ECONNREFUSED，因此把探测预算从 1.5 s
> 抬到 30 s **不会**在「没有服务器」时空等。

## 五、验证结果

`scripts/verify-040.mjs`（走插件真实后端路径，非裸 REST），
对 0.4.0-alpha 服务器 **12/12 PASS，0 failures**：

```
PASS   112786ms  status
PASS    28074ms  lookup 星乃一歌 (inner budget 90s)
PASS    21548ms  fact_pack character:1 (inner 60s)
PASS     9259ms  resolve Ichika
PASS     9196ms  term_lookup ネットパラダイス
PASS     6236ms  news ja/event
PASS     1863ms  resolveAlias khn3 (box)
PASS      706ms  resolveAlias wl3 (wl)
PASS        6ms  resolveAlias 官方箱活名
PASS        0ms  looksLikeAliasQuery
PASS        0ms  probe
PASS    64315ms  web_lookup (inner 240s)
```

`scripts/audit-timeouts.mjs` 断言每个工具「外层 > 内层」：

```
sekai_probe     outer=3000    pure-local (no HTTP)
sekai_lookup    outer=100000  inner=90000
sekai_fact      outer=70000   inner=60000
sekai_resolve   outer=45000   inner=35000
sekai_term      outer=45000   inner=35000
sekai_alias     outer=70000   inner=60000
sekai_web       outer=250000  inner=240000
sekai_news      outer=45000   inner=35000
sekai_status    outer=70000   inner=60000
→ all tools: outer budget > inner abort budget
```

## 六、上游处置（方案 B）——已完成（2026-09-19 perf remediation）

1. **每请求全量重载 + 双重 deepcopy（§3.1）——已修**：`Core.load_snapshot` 现按
   `(committed revision, data version)` 缓存已解析的 SQL 投影（上限 2 份），同修订
   的请求直接复用；factpack 文件不随 revision 原子，故每次请求按文件签名重查
   （未变时仅一次 `stat()`）。内部方法经 `CoreSnapshot.raw()` 共享只读集合，去掉
   每次属性访问对 ~71k 实体的 deepcopy；对外交接边界（`view.registry` /
   `view.snapshot.*`）与 `request_scoped` 返回值拷贝保持不变（P02 隔离契约与
   `test_snapshot_and_returned_mutations_are_detached` 等原样通过）。
2. **`/health` 不该走 registry 深拷贝（§3.3 前半）——已修**：`Core.ready()` 不再
   request_scoped，实例缓存命中即时返回，空库回落到 `dbstore.store_has_knowledge`
   的 `LIMIT 1` 存在性探测。`/health` 实测 **1.6–2.7 ms**（原 21–40 s）。
3. **中止请求的槽位（§3.3 后半）**：复核确认槽位释放已有 try/finally 兜底、无
   泄漏路径；`_reject` 的写失败现被吞掉（OSError），死套接字上的 503 不再刷
   服务端栈。真实治本来自前两项：请求从 ~20 s 降到毫秒级，16 槽不再被慢请求
   占死，探测风暴即使复现也无法再饿死服务器。

上游实测（同一 store，探针脚本 `work/_perf_probe_040.py`，基线 → 修复后）：

| 步骤 | 基线 | 修复后 |
| --- | --- | --- |
| ready（即 /health 成本） | 17.9–18.5 s | **<10 ms** |
| lookup 星乃一歌 #1 / #2 | 19.1 / 20.4 s | 9.3 s（快照冷载）/ **3.0 s** |
| freshness | ~17.7 s | **0.01 s** |
| fact_pack character:1 | 18.6 s | **<20 ms** |
| term_lookup | 7.4 s | **0.21 s** |
| resolve_name | 6.7 s | 1.4 s |
| news | 4.3 s | **0.11 s** |
| trust_summary 冷 / 暖 | 49.4 / 4.7 s | 13.0 s（一次性）/ **<10 ms** |
| status | 64.4 s | 20.1 s（首次聚合）/ 暖 <10 ms |
| web_lookup | 123.4 s | ~137 s（`web_search` 全量线性评分，计算型，与快照无关） |

上游回归：**979 tests + 273 subtests 全绿**（原 972 + 新增
`tests/test_core_snapshot_cache.py` 7 用例：同 revision 单次加载、revision
bump/refresh 强制重载、factpack 不被 projection 缓存钉死、ready 不进 view、
结果不别名共享快照）；契约快照 `drifted=[]`；Astra 验证器 14 语义域全绿。

### 插件端复测（修复后服务器，`scripts/verify-040.mjs`）12/12 PASS

| 工具 | 修复前（§五） | 修复后 |
| --- | --- | --- |
| status | 112,786 ms | **6,726 ms** |
| lookup 星乃一歌 | 28,074 ms | **2,806 ms** |
| fact_pack | 21,548 ms | **15 ms** |
| resolve | 9,259 ms | **1,148 ms** |
| term_lookup | 9,196 ms | **153 ms** |
| news | 6,236 ms | **34 ms** |
| resolveAlias khn3 / wl3 | 1,863 / 706 ms | 1,563 / 653 ms |
| web_lookup | 64,315 ms | 53,635 ms |
| probe | 0 ms | 1 ms |

§四 抬高的预算**保持不变**：它们当初把「必然间歇失败」变成「宽裕」，本轮上游
修复把真实成本降回正常，两者不冲突。唯 `web_lookup` 仍受 `web_search` 的全量
线性评分支配（Astra P06 明示保留 Python 评分以保 recall），~54–137 s，内层
240 s 预算继续覆盖。

## 七、结论

- **API 契约面**：确认**可无缝应用**（DSH 0.1.5-rc.2 + 0.4.0-alpha，实测）。
  9 个工具全部注册、可调用、数据正确。
- **可用性面**：§三 记录的性能回归（每请求重载 + 双重 deepcopy + `/health`
  全量路径）**已在上游修复**（§六，方案 B）。本文件 §三/§四/§五 保留作为
  回归期间的事实记录；修复后各工具延迟回到毫秒级～秒级，12/12 复测通过。
- **已处置**：方案 A（插件侧预算抬高）+ 方案 B（上游 perf remediation）
  双管齐下；插件预算保留作为安全垫，实测 12/12 通过。
- **README 的「零改动即兼容」**就 API 契约而言成立；就性能而言在 0.4.0-alpha
  发布时一度不成立（§三），上游修复后恢复成立。

## 八、独立复验（2026-09-20，插件侧）

§六 由修复方撰写。以下为**独立复验**：不采信 §六 数字，重跑探针与插件全链路。
复验对象是当前工作树 HEAD（`ada3e08`，比修复提交 `d4cf781` 又前进 5 个提交）。

### 8.1 独立复现 §六 的延迟表（脚本 `scripts/recheck-section6.mjs`）

| 端点 | 本次实测 | §六 声称 | 判定 |
| --- | --- | --- | --- |
| `/health` | **35 ms** | 1.6–2.7 ms | ✅ 同量级（毫秒级） |
| `freshness` | 4265 ms 冷 / **7 ms 暖** | 0.01 s | ✅ 暖值一致 |
| `fact_pack character:1` | **5 ms** | <20 ms | ✅ |
| `lookup` 冷 / 暖 | **2416 / 2255 ms** | 9.3 s / 3.0 s | ✅ 更好 |
| `term_lookup` | **144 ms** | 0.21 s | ✅ |
| `resolve` | **969 ms** | 1.4 s | ✅ |
| `news` | **73 ms** | 0.11 s | ✅ |
| `activity` | 1298 ms | n/a | ✅ |
| `trust` | 8902 ms 冷 / **12 ms 暖** | <10 ms 暖 | ✅ |
| `status` | 16158 ms 首次 | 20.1 s 首次 | ✅ |
| `web_lookup` | **121335 ms** | ~137 s | ✅ **确认仍未改善** |

`freshness`/`trust`/`status` 的差异经查是**冷/暖之分**，非偏差：同一服务器
连测两次得 `freshness` 4265→7 ms、`trust` 8902→12 ms、`/health` 4→2 ms。
§六 表格标注的是暖值，结论一致。

### 8.2 独立复现「探测风暴」是否已失效（脚本 `scripts/verify-probe-budgets.mjs`）

用**原始上游预算**（未采用我 §四 的放宽值）在修复后服务器上重跑：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 原始 1500 ms 就绪探测 | 必然失败，30 s 内 ~35 次全灭 | **第 1 次即成功** |
| 原始 1200 ms 外部端口探测 | 永远探测不到 → 重复 spawn | **命中**（复用恢复） |
| 20 s 密集 1500 ms 探测 | — | **65/65 成功**，之后 `lookup` 7000 ms 正常、`freshness` 5 ms |

结论：**§3.3 的探测风暴根因已被上游消除**。我 §四 对 `backend.js` 的探测
放宽（30 s/60 s/2 次）**不再是必需**，但保留为安全垫 —— 对修复后的
`/health`（毫秒级）零成本，对未升级的 0.4.0-alpha 服务器则是唯一可用路径。

### 8.3 一处自我修正

§四 我让 `ensureServer` 在「未确认就绪」时**抛错**。复验后改回**乐观放行**：
`spawnServer` 已等到达 `listening on` 横幅，端口即刻可用，抛错会把一次迟到的
`/health` 放大成硬失败；乐观放行则由真实调用的错误说话，更贴近上游
「横幅即就绪」的原意。已在 `lib/backend.js` 修正。

### 8.4 插件在真实 DSH 会话中的复验

本会话宿主（DSH 0.1.5-rc.2）加载的插件子进程启动于 **09-19 15:15:49**，
**早于修复提交（17:37:24）**，故其内存里是修复前的 `sekaisync` 代码 ——
实测该进程 `/health` 仍 21328 ms、`lookup` 23751 ms。**杀掉该子进程后**
插件按新代码重生（端口 49689），9 个工具**全部即时可用**：

| 工具 | 结果 |
| --- | --- |
| `sekai_lookup 星乃一歌` | ✅ 返回 character:1 + 2 个礼包（此前 30 s 超时） |
| `sekai_status` | ✅ ready=true，五服覆盖 |
| `sekai_alias wl3` / `官方箱活名` | ✅ 5 个 WL / 雨上がりの一番星 |
| `sekai_fact` / `sekai_resolve` / `sekai_term` / `sekai_news` / `sekai_web` / `sekai_probe` | ✅ 全部正常 |

**另发现上游第二个已修回归**（提交 `2e6d0bf`）：`load_news` 原按 store 物理顺序
（≈最旧优先）返回，任何 `[:limit]` 消费者都只看得到 2020 年窗口。实测确认：
修复前 `news` 首条为 2026-08-23，修复后首条 2026-09-30 且 `limit=20/100`
均严格降序 —— `compactNews` 无需改动即受益。

### 8.5 API 面未受影响

`git diff b237829..HEAD` 对插件相关面：`tools.py` 仅新增 `query` 工具的
`include_web`（插件不调用 `query`）；`news` 的参数与响应字段（`published_at`/
`information_tag`/`body_available`/`url`/`items`/`matched`）无变化；
`core.py`/`http_server.py` 改动为内部实现。DSH 契约复检：9 工具
`parameters.type=object`、`required⊆properties`、`output.render` 齐备。

### 8.6 仍待关注

`web_lookup` 仍是 **121 s**（§8.1 实测，与 §六 的 ~137 s 一致）：这是
`web_search` 的全量线性 Python 评分（Astra P06 为保 recall 刻意保留），
与快照重构无关。插件内层 240 s / 外层 250 s 预算继续覆盖，但这是当前
唯一的「秒级以上」工具，值得上游后续单独优化。

