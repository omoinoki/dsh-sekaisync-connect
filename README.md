<!-- readme-brand:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/header-dark.svg">
  <img src=".github/readme/header-light.svg" alt="" width="1280">
</picture>
<!-- readme-brand:end -->

# SekaiSync Connect for DeepSeek Harness

English | [中文](README.zh-CN.md)

[![Release](https://img.shields.io/badge/Release-0.3.2--alpha-006F78?style=flat&labelColor=17263B)](package.json) [![Runtime](https://img.shields.io/badge/Runtime-Node.js%2020%2B-4F6175?style=flat&labelColor=17263B)](package.json) [![Platform](https://img.shields.io/badge/Platform-Cross--platform-4F6175?style=flat&labelColor=17263B)](package.json) [![License](https://img.shields.io/badge/License-MIT-AC246D?style=flat&labelColor=17263B)](LICENSE)

<!-- readme-navigation:start -->
<p>
  <a href="#readme-overview">Overview</a> ·
  <a href="#readme-section-01">Quick start</a> ·
  <a href="#readme-section-09">More information</a>
</p>
<!-- readme-navigation:end -->

<a id="readme-overview"></a>

A **DeepSeek Harness direct-connect module** for the SekaiSync knowledge base: zero dependencies, zero build steps, and minimal token usage.

<a id="readme-section-01"></a>

## Installation

```powershell
# 环境要求：Python ≥ 3.10 且可 `python -m sekaisync`（零第三方依赖），
# 以及一个已同步的 store（sekaisync init / sync 产物）。

# 常规插件装配（bundle patch，DSH 官方机制）
dsh plugin --profile web add <本目录>
```

| Runtime | Verdict |
| --- | --- |
| `0.1.5-rc.2` | allow |
| `0.1.7-rc.2` | allow |
| `0.1.8` | allow |
| `0.2.0-rc.1` / `0.2.0` | **DENY** (unverified versions fail closed; use `dsh plugin allow-version` for an exception) |

<a id="readme-section-03"></a>

## Configuration

Precedence: **environment variables > profile row config > `SEKAISYNC_CONFIG` file > plugin-directory `config.local.json` > `config.json` > automatic discovery**.

| Setting | Description |
| --- | --- |
| `SEKAISYNC_STORE` | Store directory containing `kb/`. When omitted, discovery checks `<SEKAISYNC_ROOT>/store`, cwd/store, and the repository store located with `python -c "import sekaisync"` |
| `SEKAISYNC_ROOT` | SekaiSync repository root, used as the working directory for `python -m sekaisync` |
| `SEKAISYNC_PYTHON` | Python executable; defaults to `python` |
| `SEKAISYNC_PORT` | Port to probe for an existing server; defaults to 8787. If a ready SekaiSync service is already listening there, it is reused instead of starting another process. 0 retains its meaning: skip the external probe and start a managed service directly |
| `SEKAISYNC_MAX_RESPONSE_BYTES` | Byte budget for one successful HTTP response; defaults to 134217728 (128 MiB), configurable from 65536–1073741824. It can also be set as `maxResponseBytes` in a configuration file or profile row. Exceeding the budget cancels the read and returns an explicit error |

You can also override these settings in your own profile patch; plugin upgrades do not overwrite that layer:

```yaml
- id: dsh-sekaisync-connect
  name: 'dsh-sekaisync-connect'
  config:
    store: 'D:\\sekaisync\\store'
    python: 'py'
```

- HTTP connects only to loopback and rejects redirects. Health and error responses are limited to 64 KiB and 4 KiB respectively. The default successful-response budget is 128 MiB, covering typical body results with `limit=100` and `max_text_chars=200000`. `max_text_chars=0` still means full text upstream; if an exceptionally large full-text response exceeds the transfer budget, increase `maxResponseBytes` (up to 1 GiB) or read in batches.
- External-port reuse still follows the existing `/health` ready/status check. That endpoint carries no store identifier, so you must ensure the configured port serves the intended knowledge base.

<a id="readme-section-08"></a>

## Usage Recommendations (Token Discipline)

1. Use `sekai_resolve` before generating any localized text. Use `sekai_fact` for precise facts; do not let the model answer from memory.
2. For an unfamiliar term, an uncertain topic, or a character name with an unknown source, first use `sekai_probe` to determine whether it concerns Project Sekai, then route to local tools or the web. Matches directly suggest a `next_tool`.
3. For time-sensitive questions such as current events, gachas, and maintenance, check freshness and coverage with `sekai_status` first.
4. To verify a localized name in context, use `sekai_term` to confirm the term exists, then `sekai_penetrate` to inspect aligned lines across languages. Remember that `missing` explicitly means there is no corresponding line in that language; it is not an error.
5. `sekai_web` is slow; use it only when quoting original story text. Try `sekai_lookup` / `sekai_term` first, or use `sekai_probe` to confirm the direction.
6. Ask directly with event shorthand or an official event name, whether a unit-focused event or World Link. `sekai_lookup` automatically includes activity resolution, and `sekai_alias` supports shorthand, official event names, and natural-language questions.
7. If a result is truncated, reduce `limit` or use a more precise query.

<a id="readme-section-09"></a>

## Troubleshooting

- `ERROR: 未找到 sekaisync 知识库 store`: set `SEKAISYNC_STORE` or edit `config.json`.
- `ERROR: 无法启动 python …`: confirm that `python -m sekaisync --help` works. If the package is missing, run `pip install -e <sekaisync 仓库>`.
- Server 60-second cooldown: automatic restarts pause after 2 consecutive crashes. Check the integrity of the store with `python -m sekaisync --no-event-check integrity`.
- `ERROR: HTTP …` in a tool result: the server has started but the request failed, usually because of a parameter issue. `sekai_status` reports the service mode and store path.
- `ERROR: 缺少必填参数 …`: the plugin's guard caught a missing argument. Supply the requested argument and retry.
- If `sekai_probe` reports `词表来源=static`, the dynamic lexicon (`terms export`) has not finished warming or its build failed.
  The probe has fallen back to the built-in static lexicon; retry later or check store integrity.
