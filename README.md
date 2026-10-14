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

**Header readout** — the primary route's balance or quota. Click for a popover with:

- every route: vendor, billing mode, and the figure or quota windows it reports
- the endpoint used, when it was last read, and the credential variable name
- a **Refresh now** button that bypasses the failure cooldown and re-queries everything

**Readings can be stale.** When an automatic query fails but a previous one succeeded, the readout keeps the older figure, marks it with a `·`, and the popover states the failure. A stale number is never presented as current.

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
| `unknown-provider` | **this plugin has not catalogued the route** — which is *not* the same as the vendor having no endpoint |
| `no-public-endpoint` | catalogued, and that vendor definitively has no public endpoint |
| `parse-failed` | HTTP 200, but the response shape is unrecognised — **echoes a raw response fragment** |

Echoing the body on `parse-failed` is deliberate: the eight response shapes were compiled from vendor documentation, and **the author holds no keys for these vendors, so none could be verified against a live API during development.** The echo is how you see what actually came back.

Echoed bodies are redacted (`sk-…`, `Bearer …`, `{ "api_key": … }` and similar become `***`) and truncated to 800 characters.

## Permissions and privacy

- **No `exec` capability, no subprocess.** No shell, no `curl`, no process spawning.
- **Only the eight vendors' official hosts.** An uncatalogued route does not fall back to "try some likely paths" — it reports `unknown-provider`.
- **A key only ever goes to its own vendor.** Read through `ctx.credentials.resolve()`, placed in a request header, never written to disk, logs, or the browser snapshot. The snapshot carries the credential *variable name* and no value — there is a test asserting this.
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

**Refresh policy.** The host holds no timer. The browser half polls the snapshot route every 60s, and the host decides whether that poll is allowed to become a real vendor request (bounded by `minIntervalSec` and the failure cooldown). Keeping the clock in the browser removes a whole class of lifecycle bugs, and nothing is lost: freshness matters only to the readout, which exists only while the page is visible. A hidden page does not poll.

**Caching.** The endpoint that worked is cached per route; after every candidate fails the route enters a 10-minute cooldown; concurrent queries for one route coalesce into a single in-flight request.

## Known differences from the reference implementation

- **Auto-refresh is poll-driven, not turn-end driven.** The reference hooks `usage://done`. DSH's session-event vocabulary is not publicly documented and I could not observe it in a live session, so rather than ship a guessed listener that would misfire on unrelated session events, this version polls. Adding the hook once the event shape is confirmed is a small, isolated change.
- **The readout describes the primary route, not "the current session's route".** The header slot does receive a `sessionId`, but a stable host-side per-session model lookup was not confirmed. Resolution order is the configured `primary`, then the first catalogued route. Showing the default is preferred over claiming a session route and being wrong.
- **No relay-station probing.** The reference carries seven probe chains for uncatalogued gateways. This version queries catalogued domains only — a deliberate trade: requesting unknown domains would void the "official hosts only" guarantee.

## Development

```sh
npm run verify   # static contract check + the full test suite
npm test         # 160 tests, no DSH required
npm run check    # static contract check only
```

Tests come in three layers, all runnable **without DSH**:

- **Pure logic** — catalog matching, the eight response parsers, cache/throttle/cooldown/coalescing, route discovery — with an injected clock and fetch, so results are deterministic.
- **Host-half integration** — stubs stand in for the `@deepseek-ai/*` packages and the real `apply()` runs, covering tool registration, credential resolution, the snapshot route, and config writes.
- **Static contract** — `package.json`, `cordis.patch.yml` and the browser half checked for self-consistency: every bare import declared, the bundle patch naming this package, the module id equal to the package name, and `files` shipping both entry points.

The design spec is at [docs/superpowers/specs/2026-10-14-dsh-balance-meter-design.md](docs/superpowers/specs/2026-10-14-dsh-balance-meter-design.md) (Chinese).

## License

MIT
