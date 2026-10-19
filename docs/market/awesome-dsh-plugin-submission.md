# Submission for awesome-dsh-plugin

Target path in the index repo: `data/plugins/zhujiuyi__dsh-balance-meter.yml`

Open a PR against https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
that adds exactly this one file. Nothing else is needed — both READMEs are
regenerated on `main` after merge, so do not edit them by hand.

```yaml
url: https://github.com/zhujiuyi/dsh-balance-meter
name: zhujiuyi/dsh-balance-meter
category: usage
description:
  en: 'Reads the API balance or subscription quota behind the current DSH route — including OpenDesign (AMR) wallet and Design Plan windows via the control plane — and never guesses a figure: a miss reports its cause with the response echoed.'
  zh: '读取当前 DSH 路由背后的 API 余额或订阅余量——包括经控制面读取 OpenDesign（AMR）的钱包与 Design Plan 窗口——绝不猜数字：查不到时如实说明原因并附原始响应。'
```

## Why the description carries quotes

Both descriptions contain `: ` (colon + space) — `"a miss reports its cause"`
appears after one. Per `contributing.md`, an unquoted `: ` makes YAML parse the
rest as a nested key, so the quoting is required, not stylistic.

## Checklist against the review requirements

| Requirement | Status |
|---|---|
| `dsh.bundle` manifest in `package.json` | ✅ `{"bundle": {"patch": "./cordis.patch.yml"}}` |
| `cordis.patch.yml` at repo root | ✅ present, registers row `balance-meter` |
| Repo at least 1 day old | ✅ created 2026-10-14 (5 days) |
| `dsh-plugin` topic | ✅ present |
| Real, working code | ✅ 264 tests, contract check, live-verified against 7 vendor endpoints |
| Not a meta-package | ✅ ships behaviour; depends on nothing at runtime |
| Category reasonable | `usage` = "Usage & Billing" — the entry's whole job |

## Expected listing fields once npm is published

The index derives these from the published npm package, so they appear only
after `@zhujiuyi/dsh-balance` exists on npmjs:

- `npm`: `@zhujiuyi/dsh-balance`
- `version`: whatever `dist-tags.latest` reports
- `install`: `dsh plugin --profile web add @zhujiuyi/dsh-balance`
- `downloads`: counted from the npm download API

Before the publish, the card would render with `npm: null` / `version: null` and
an `install` line pointing at GitHub. That is why the npm publish must happen
first.
