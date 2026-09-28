<!-- readme-brand:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/header-dark.svg">
  <img src=".github/readme/header-light.svg" alt="" width="1280">
</picture>
<!-- readme-brand:end -->

# SekaiSync Connect for DeepSeek Harness

English | [中文](README.zh-CN.md)

[![Release](https://img.shields.io/badge/Release-0.3.3--alpha-006F78?style=flat&labelColor=17263B)](package.json) [![Runtime](https://img.shields.io/badge/Runtime-Node.js%2020%2B-4F6175?style=flat&labelColor=17263B)](package.json) [![Platform](https://img.shields.io/badge/Platform-Cross--platform-4F6175?style=flat&labelColor=17263B)](package.json) [![License](https://img.shields.io/badge/License-MIT-AC246D?style=flat&labelColor=17263B)](LICENSE)

<!-- readme-navigation:start -->
<p>
  <a href="#readme-overview">Overview</a> ·
  <a href="#readme-section-01">Quick start</a> ·
  <a href="#readme-section-panel">Plugins panel</a> ·
  <a href="#readme-section-tools">Tools</a> ·
  <a href="#readme-section-09">More information</a>
</p>
<!-- readme-navigation:end -->

<a id="readme-overview"></a>

A **DeepSeek Harness direct-connect module** for the SekaiSync knowledge base: zero dependencies, zero build steps, and minimal token usage — plus a Plugins-panel page for choosing the deployment path.

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

<a id="readme-section-panel"></a>

## Choosing the deployment path in the Plugins panel

When a Web profile serves the client, the plugin also appears as a **Configure** page on its row under **Plugins** in the sidebar. That page selects the SekaiSync deployment from the GUI instead of editing JSON by hand.

Open **Plugins → Installed → dsh-sekaisync-connect → the row's Configure control**. The page offers:

| Control | What it does |
| --- | --- |
| Path field + **Check** | Classifies the path and reports whether it is a store, a repository root, or a `kb/` directory — plus database size, `kb/` entry count, and the `freshness` payload when present |
| **Save and apply** | Writes `config.local.json` and hot-reloads the backend, so the new path takes effect without restarting DSH |
| **Auto-detect** | Scans bounded, local-only locations (environment variables, `cwd`, common home directories, and siblings of the plugin directory) for candidate deployments |
| **Choose folder…** | Opens the OS folder chooser when the host mounted the native directory picker |
| **Browse** | In-app directory browsing, used when no native picker is available (remote or headless sessions) |
| **Test connection** | Performs a real `/health` request against the selected deployment and reports latency and readiness |

The source row above the form names the configuration layer currently in effect. It matters: precedence is environment variables > profile row config > `SEKAISYNC_CONFIG` > `config.local.json` > `config.json`. When a higher layer already fixes `store`, the form says **overridden by a higher layer** — saving still writes the file, but the new value has no effect until that layer changes.

Constraints, by design:

- The panel writes only `store` and `root`, in the plugin's own `config.local.json`, and only after the path passes classification. `python` is deliberately **not** editable from the panel: exposing an executable path over HTTP would put arbitrary program execution on a web page. The worst a panel write can do is point the knowledge base at another directory.
- Panel routes are exact `POST` routes under `/api/sekaisync` on the DSH Web server, registered through `ctx.connection.fetch.register`. Because they live under the `/api` prefix, the framework's Connection layer already fences them: a Host/Origin trust check plus browser cookie authentication. Hand-rolling a `remoteAddress` check instead would both break `trustedHosts` support and miss DNS rebinding, so the panel deliberately relies on the framework's fence. A profile without a Web client connection layer never registers them.
- The panel is an addition, not a requirement. Without it, the file-based configuration above works exactly as before.

<a id="readme-section-tools"></a>

## Tools

Ten model-facing tools, all read-only against the local knowledge base:

| Tool | Cost | Purpose |
| --- | --- | --- |
| `sekai_probe` | ~1 ms | Decide whether a topic is Project Sekai at all; returns `verdict` plus a suggested next tool |
| `sekai_lookup` | ~2.3 s | Match entities (characters, events, cards, gachas, songs, areas) by name in any language, with cross-region names and event-shorthand resolution |
| `sekai_fact` | ~5 ms | Compact fact pack for one entity id (e.g. `character:1`, `card:123`) — the cheapest way to get structured facts |
| `sekai_resolve` | ~1 s | Resolve a proper noun to its official localized name; reports `translation_status` honestly instead of leaving gaps |
| `sekai_term` | ~150 ms | In-game terminology and cross-language glosses, with tags, weight, and evidence lines |
| `sekai_penetrate` | 40–100 s | Cross-language penetration of one term at one story point, aligned per language |
| `sekai_alias` | ~1.3 s | Resolve event shorthand (`khn3`, `wl3`) and official event names, including natural-language questions |
| `sekai_web` | 40–160 s | Full-text search over crawled story text; use when quoting original lines |
| `sekai_news` | ~80 ms | Official announcements across the five regions, filterable by language, category, and body availability |
| `sekai_status` | 6–33 s | Knowledge-base readiness, data freshness, per-region coverage, and sync rate |

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
- The row's **Configure** page is missing: the panel needs a Web profile with the plugin-manager UI. Confirm `ui-plugin-manager` is in the profile, that the bundle is switched on, and that the plugin was installed after this release — a package installed from GitHub does not carry the gitignored `config.local.json`, so also confirm the deployment path is resolvable (see the first item above).
- **Save and apply** reports success but the old path stays in effect: a higher layer (environment variable or profile row config) fixes `store`. The page names that layer; change it there instead.
- `forbidden` or `unauthorized` from `/api/sekaisync/*`: the request did not pass the framework's Host/Origin and cookie fence. Panel routes are intentionally restricted to the authenticated local client.
- If `sekai_probe` reports `词表来源=static`, the dynamic lexicon (`terms export`) has not finished warming or its build failed.
  The probe has fallen back to the built-in static lexicon; retry later or check store integrity.
