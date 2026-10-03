# Changelog

## 0.3.9-alpha.1 - 2026-10-03

### Regional Facts And Evidence

- Add optional `region` to `sekai_fact` and accept the documented Chinese aliases
  `zh_cn` and `zh_tw` without changing other tools' language enums.
- Require matching region and scope metadata for explicit-region results, so an
  old HTTP backend cannot silently ignore the parameter and claim scoped success.
- Preserve regional lookup evidence, body status, coverage, selected language,
  provenance, missing data, and region-disambiguation instructions in compact
  outputs. Safety metadata precedes large prose and survives truncation.

### Errors And Deployment Paths

- Propagate invalid arguments, HTTP/JSON failures, deadlines, and cancellation as
  tool errors instead of successful `ERROR:` strings. Successful empty/domain
  results remain explanatory text when the backend supplies them.
- Require the core freshness endpoint for status. Report failed optional status
  endpoints explicitly while preserving available data.
- Distinguish an unresolved activity from complete activity-service/index
  unavailability; preserve healthy legacy HTTP fallbacks and optional lookup
  enrichment without swallowing caller cancellation.
- Preserve a configured source working directory when a separate store has no
  neighboring SekaiSync source evidence. Check and Save share the same decision.
  New source repositories may change the root; an installed-package fallback
  with no prior root is clearly identified as an unverified inference.

### Upgrade And Verification

- Use SekaiSync 0.4.2-alpha for the new regional evidence and body-state contract.
  Unscoped legacy calls remain compatible; scoped calls to an older backend fail
  explicitly and request an upgrade rather than inventing a region filter.
- Restart an existing plugin/backend process to load new code. Updating the
  plugin cannot recover description fields lost in an old database; rebuild or
  re-sync that store from retained raw data with the updated backend.
- Verified through regression tests, the official tool runtime, and Computer Use
  in an isolated real installed DeepSeek Harness 0.2.0-rc.2 Web profile. GUI
  scenarios used a deterministic local QA provider with real plugin tool calls,
  not a paid remote-model run or a production-profile/data migration.
- The latest official source contract was refreshed at commit
  `da00f7f5358f2949383b35c14f548bc20187d80c`; consumed tool, Remote, Settings,
  compatibility, and configuration-slot contracts remain compatible. This
  static source audit is distinct from the installed release's GUI acceptance.
- Distribution remains GitHub source/tag and installable package assets. This
  release does not introduce an npm publishing channel.
