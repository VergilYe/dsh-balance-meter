[中文](README.zh-CN.md) | **English**

# dsh-balance-meter

A native **DeepSeek Harness (DSH)** plugin: read the provider behind your current model route, then query its **API balance** or **subscription quota**.

A readout sits in the session header, with a popover listing every route. On the model side a `balance_check` tool lets the agent answer "how much credit is left?" on demand.

This is the DSH counterpart of [ccgui-plugin-balance-meter](https://github.com/zhujiuyi/ccgui-plugin-balance-meter). Because DSH exposes natively what that host lacked, this version **requests no `exec` capability, spawns no subprocess, and probes no relay stations**:

| | CC GUI version | This plugin |
|---|---|---|
| Credentials | parses each engine's config file, needs `exec:curl` | `ctx.credentials`, no shell |
| Network | host egress required a declared domain, so `exec:curl` | plain `fetch` in the host process |
| Route identity | sniffs gateway hostnames | `ctx.llm.listProviders()` + profile config |

## Install

```sh
dsh plugin --profile desktop add E:\订阅余量查看
```

Restart DSH. A `dsh-balance-meter` card appears on the Plugins page and the readout appears in the session header.

After editing the source, run the same command again to overwrite it (same package name) — no uninstall first.

Uninstall:

```sh
dsh plugin --profile desktop remove dsh-balance-meter
```

## What it shows

**The status row under the composer** — the same row as the built-in `1 turn 6 steps · 165 tok/s` pills, to their left. A balance route shows money (`¥12.34`); a subscription shows remaining quota (`每月 剩 47%`). Click for a popover with:

- the vendor, billing mode, credential variable, endpoint, and when it was last read
- for subscriptions, every quota window (rolling / weekly / monthly) with a remaining-share bar and its reset time
- a **Refresh now** button that bypasses the failure cooldown

**It reports only the provider the current session actually uses.** The route comes from that session's model selection (`current.provider` in `modelDirectories`), not from every adapter registered in the build — `listProviders()` reports built-ins like `deepseek-official` and `deepseek-account` that the user never configured, and listing those is noise.

**Readings can be stale.** When an automatic query fails but a previous one succeeded, the readout keeps the older figure, labels it stale, and the popover states the failure. A stale number is never presented as current.

## Catalogued providers

Official domains only; no request ever goes anywhere else.

| Provider | Endpoint | Billing |
|---|---|---|
| DeepSeek | `GET /user/balance` | API balance |
| OpenRouter | `GET /api/v1/key` | API balance |
| Moonshot / Kimi | `GET /v1/users/me/balance` | API balance |
| SiliconFlow | `GET /v1/user/info` | API balance |
| 智谱 GLM / Z.AI | `GET /api/monitor/usage/quota/limit` | Subscription windows |
| Kimi Coding | `GET /coding/v1/usages` | Subscription windows |
| MiniMax | `GET /v1/token_plan/remains` | Subscription |
| OpenCode Go | `GET /zen/go/v1/usage` | Subscription windows |

The credential variable is resolved per route: an adapter-declared `apiKeyEnv` first, then the matching `llm-*` row in the profile's `cordis.patch.yml`, then the catalog default (e.g. `DEEPSEEK_API_KEY`).

## The four ways a query can miss

The core promise is **never to guess a number**. Every non-success lands in exactly one of these, each saying what to do next:

| Status | Meaning |
|---|---|
| `no-credential` | the credential variable exists but is unset — names the variable to configure |
| `unknown-provider` | **this plugin has not catalogued the route** and the preset chain below missed too — which is *not* the same as the vendor having no endpoint |
| `no-public-endpoint` | catalogued, and that vendor definitively has no public endpoint |
| `parse-failed` | HTTP 200, but the response shape is unrecognised — **echoes a raw response fragment** |

## Preset endpoint probing

A route outside the built-in catalogue is **not given up on**. A fixed sequence of conventional relay-panel endpoints is tried, and the first that yields a readable figure wins:

| # | Endpoint | Where it comes from |
|---|---|---|
| 1 | `GET /api/usage/token/` | New-API ≥ v0.9.0 — remaining quota in one call |
| 2 | `GET /v1/dashboard/billing/subscription` | OpenAI-style billing, in cents |
| 3 | `GET /v1/usage` | Sub2API family |
| 4 | `GET /api/v1/me/quota` | claude-code-hub, which uses an `X-Api-Key` header |
| 5 | `GET /dashboard/billing/credit_grants` | CloseAI family |
| 6 | `GET /api/v1/credits` | — |
| 7 | `GET /api/user/self` | New-API variants |

Presets 1 and 7 first make one **unauthenticated** `GET /api/status` read to pick up the panel's own `quota_per_unit` — a New-API operator can change the accounting unit, and hardcoding 500000 would be off by orders of magnitude.

**An endpoint you set outranks all of them**: the value written by `balance_set_endpoint` or `routes[].endpoint` is tried first, because that is the thing you actually know. If none of the presets fit, setting one is the fix.

A 401 or 403 **stops the chain** — every remaining path would use the same credential.

**Scope of the claim:** the mechanism (order, short-circuit, calibration, fallback) is tested and every extraction path has a fixture, but **the preset shapes themselves are transcribed from the reference project's panel catalogue and could not be re-verified per vendor**. A preset that mismatches therefore reports `parse-failed` and echoes its response, rather than returning a wrong number.

## Id aliases in the catalogue

Adapters name their own routes `deepseek-official`, `deepseek-account` and the like. Those resolve to the vendor's entry once the suffix is stripped, instead of being called uncatalogued — the vendor is plainly known. A genuinely unrelated id (say `deepseek-proxy`) is still reported as uncatalogued.

Echoing the body on `parse-failed` is deliberate: the eight response shapes were compiled from vendor documentation, and **the author holds no keys for these vendors, so none could be verified against a live API during development.** The echo is how you see what actually came back.

Echoed bodies are redacted (`sk-…`, `Bearer …`, `{ "api_key": … }` and similar become `***`) and truncated to 800 characters.

## Permissions and privacy

- **No `exec` capability, no subprocess.** No shell, no `curl`, no process spawning.
- **Requests go only to the gateway of the route you configured in DSH.** No third-party domain, no telemetry, no reporting back. A catalogued route is queried at its vendor's official endpoint; an uncatalogued one only ever at its own base URL (see *Preset endpoint probing*).
- **A key only ever goes to its own gateway.** Read through `ctx.credentials.resolve()`, placed in a request header, never written to disk, logs, or the browser snapshot. The snapshot carries the credential *variable name* and no value — there is a test asserting this.
- **No other DSH configuration is touched.** `balance_set_endpoint` edits only this plugin's own row `config`.

## Configuration

Plugins page → the `dsh-balance-meter` card → the form edits the primary route, the auto-refresh switch, and the minimum interval.

Route overrides (custom endpoints, different credential variables) go through the tool, or by editing the `balance-meter` row in the profile's `cordis.patch.yml`:

```yaml
- id: balance-meter
  name: dsh-balance-meter
  config:
    primary: deepseek
    routes:
      - id: my-provider
        baseURL: https://api.example.com/v1
        apiKeyEnv: MY_PROVIDER_API_KEY
        endpoint: '{origin}/v1/balance'
```

Endpoint templates accept `{origin}` (the route's scheme and host) and `{base}` (the route's base URL). Prefer `{origin}`: it stays correct no matter which path segment the configured base URL carries.

## Tools

**`balance_check`** — `{ route?, refresh? }`, returning structured JSON: route, vendor, billing mode, status, figure or quota windows, endpoint, query time. With no `route` it queries the route the header shows.

**`balance_set_endpoint`** — `{ route, endpoint }`, persists a custom endpoint into this profile's `cordis.patch.yml`, applied immediately. An empty `endpoint` clears the override.

> Writing `routes` sends the plugin row through the Loader's normal lifecycle (effectively a reload), so the in-memory cache resets and the readout re-queries on its next poll. That is a schemastery structural limit rather than a choice: array elements are always validated as "blocked", so a volatile field can never appear inside an array — and since route ids are user-chosen, no schema shape would make route overrides volatile (and volatile is what buys an in-place update without a reload).

## How it works

```
DSH host process                               browser
┌────────────────────────────────────┐       ┌────────────────────┐
│ dsh-balance-meter (host half)      │       │ dsh-balance-meter  │
│                                    │       │ (browser half)     │
│ ctx.llm.listProviders()  ─┐        │       │                    │
│ llm-* rows via             ├→ routes│       │  header readout    │
│   configEditor            ─┤        │       │    ↓ fetch         │
│ built-in catalog          ─┘        │       │  /api/balance-     │
│                        ↓           │       │   meter/snapshot   │
│ ctx.credentials.resolve()          │       │    ↑               │
│                        ↓           │       │    │               │
│ fetch(vendor) → parse → cache      │──────→│    │               │
│                        ↓           │ JSON  │    │               │
│ ctx.tools.register ×2              │       │  config form       │
└────────────────────────────────────┘       └────────────────────┘
```

**Refresh policy.** The host holds no timer, and nothing guesses when a turn ended.

- **After every turn**, the host listens for the session log's `turn/end` event and refreshes the current route. That event name is not guessed — it was read out of a real `session.v4.jsonl.zstd` (`{"type":"turn/end","data":{"turn":1,"reason":{…}}}`).
- **The browser half** re-reads the host's **local cache** every 10s (not a vendor request), so a reading the host refreshed appears within 10s; switching the session's model re-reads immediately.
- Vendor requests themselves are throttled host-side by `minIntervalSec` (default 30s) and the failure cooldown, so a burst of turns cannot become a burst of vendor requests. A hidden page does not poll.

**Caching.** The endpoint that worked is cached per route; after every candidate fails the route enters a 10-minute cooldown; concurrent queries for one route coalesce into a single in-flight request.

## Known differences from the reference implementation

- **Different surface.** The reference sits in the status bar; this one sits on the status row under the composer, which in DSH's slot system is `conversation.composer.dock` — the row the built-in session-stats pills use.
- **Which window the readout shows: shortest span first.** 5-hour → weekly → monthly, taking the first that reports a figure. That order is the order in which each window can block you, and a subscription is managed against its nearest cycle. It is deliberately *not* the window with the least remaining, which would sit on the monthly figure permanently. Only when no window's span is recognisable does it fall back to least-remaining.
- **An uncatalogued route is stated, not papered over.** When the preset chain misses too, the readout says *Unavailable*, explains that **this plugin has not catalogued it**, and carries the last raw response rather than inventing a figure.

## Which response shapes are verified

The eight parsers were written from vendor documentation, and the author holds no keys for these vendors — **only OpenCode Go has been checked against a live response**, which is what fixed it:

```json
{"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"…"},
          "weekly":{"status":"ok","percent":8,"resetsAt":"…"},
          "monthly":{"status":"ok","percent":53,"resetsAt":"…"}}}
```

`percent` here is a **used** share, not a remaining one. That is inferable rather than assumed: a live account read `rolling: 0` while actively completing turns, which cannot mean "0% remaining". The remaining figure is derived from it, and the raw value is kept in the window note (`原始 percent=53`) so a change of convention at the vendor would be visible immediately.

If any of the other seven disagrees with its documentation, it reports `parse-failed` and echoes the response — send that echo and it can be corrected.

## Development

```sh
npm run verify   # static contract check + the full test suite
npm test         # 209 tests, no DSH required
npm run check    # static contract check only
```

Tests come in three layers, all runnable **without DSH**:

- **Pure logic** — catalog matching and id aliases, the eight response parsers, the seven-preset probe chain, cache/throttle/cooldown/coalescing, route discovery — with an injected clock and fetch, so results are deterministic.
- **Host-half integration** — stubs stand in for the `@deepseek-ai/*` packages and the real `apply()` runs, covering tool registration, credential resolution, the snapshot route, and config writes.
- **Static contract** — `package.json`, `cordis.patch.yml` and the browser half checked for self-consistency: every bare import declared, the bundle patch naming this package, the module id equal to the package name, and `files` shipping both entry points.
- **Schema guard** (`test/config-schema.test.mjs`) — validates `Config`'s volatile paths against a stub that mirrors the real rule. Mirroring it rather than waving it through matters: a structurally invalid `Config` fails no behavioural test, it just stops the plugin activating in a user's install. `routes[].id` escaped that way once.

The design spec is at [docs/superpowers/specs/2026-10-14-dsh-balance-meter-design.md](docs/superpowers/specs/2026-10-14-dsh-balance-meter-design.md) (Chinese).

## License

MIT
