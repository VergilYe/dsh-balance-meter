# Submission for awesome-dsh-plugin

**Status: submitted.** PR #8156 →
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8156
(opened 2026-10-19, one file only, `mergeable=true`)

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

## Listing fields, now that npm is published

`@zhujiuyi/dsh-balance@0.1.0` is live on npmjs (published 2026-10-19), so the
index can derive these:

- `npm`: `@zhujiuyi/dsh-balance`
- `version`: `0.1.0` (`dist-tags.latest`)
- `install`: `dsh plugin --profile web add @zhujiuyi/dsh-balance`
- `downloads`: counted from the npm download API

Note for anyone re-verifying: `0.0.0-stage` also appears in the version list.
That is npm's own placeholder for a newly created scoped package
(`"stub": true`, "Temporary package placeholder for staged publishing"), not
something this repo published.

### Why `registry.npmjs.org` may 404 locally

On the machine this was published from, `registry.npmjs.org` resolves to
`198.18.0.43` — the fake-IP range a proxy's TUN mode hands out — while the real
Cloudflare addresses are `104.16.x.x`. Queries over that path returned 404 for a
package that existed; jsDelivr and unpkg (which read npmjs directly) both
confirmed it. If a local `npm view` says the package is missing, check
`Resolve-DnsName registry.npmjs.org` before concluding the publish failed.
