# Changelog

## 0.3.9-alpha.1 - 2026-10-03

### Changes

- `sekai_fact` can select a region (`jp`, `en`, `tc`, `kr`, or `cn`) and accepts `zh_cn` and `zh_tw` as Chinese language aliases.
- Fact and lookup results retain regional evidence, text language, source information, and missing-data status in compact output.
- Failed tool calls are reported as errors. `sekai_status` keeps available status data and identifies any unavailable supplemental information.
- Activity-name resolution distinguishes an unmatched name from an unavailable service.
- Saving a separate store directory preserves the configured SekaiSync source root; selecting another source repository updates it consistently.

### Upgrading

- Install this version with `dsh plugin --profile web add github:omoinoki/dsh-sekaisync-connect#v0.3.9-alpha.1`.
- Use SekaiSync `0.4.2-alpha` for regional facts and description data, then restart DSH and any running SekaiSync backend to load the updated code.
- For an older store missing description fields, rebuild from retained raw data or run a new sync with the updated SekaiSync.
