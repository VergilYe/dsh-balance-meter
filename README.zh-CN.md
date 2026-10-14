**中文** | [English](README.md)

# dsh-balance-meter

DeepSeek Harness（DSH）原生插件：**按当前路由识别供应商与计费方式，查询 API 余额或订阅余量**。

会话标题栏常驻一个读数，点开是全部路由的详情；模型侧另有一个 `balance_check` 工具，你问「还剩多少额度」时它会主动查询。

本插件是 [ccgui-plugin-balance-meter](https://github.com/zhujiuyi/ccgui-plugin-balance-meter)（CC GUI 插件）在 DSH 上的对应实现。因为 DSH 原生提供了 CC GUI 所缺的能力，这一版**不需要任何 exec 权限、不启动任何子进程、不做中转站探测**：

| | CC GUI 版 | 本插件 |
|---|---|---|
| 读凭据 | 自己解析各引擎配置文件，须 `exec:curl` | `ctx.credentials` 直接读，无 shell |
| 联网 | 宿主 HTTP 出口要求预先声明域名，只能用 `exec:curl` | 宿主进程内直接 `fetch` |
| 识别路由 | 嗅探网关域名 | `ctx.llm.listProviders()` + profile 配置 |

## 安装

```sh
dsh plugin --profile desktop add E:\订阅余量查看
```

装完重启 DSH，插件页会出现 `dsh-balance-meter` 卡片，会话标题栏出现读数。

装完再改代码，重跑同一条命令即可覆盖（同一包名），不需要先卸载。

卸载：

```sh
dsh plugin --profile desktop remove dsh-balance-meter
```

## 它显示什么

**输入框下方的状态行**（与 `1 轮 6 步 · 165 tok/s` 同一行，在它左侧）常驻一个读数：余额是钱数（`¥12.34`），订阅是余量百分比（`每月 剩 47%`）。点开是详情弹层：

- 该路由的供应商、计费方式、凭据变量、接口地址、最近读取时间
- 订阅渠道逐个列出额度窗口（滚动 / 每周 / 每月），各带剩余进度条与重置时间
- 「立即刷新」按钮（跳过失败冷却）

**只显示当前会话实际在用的那一个供应商。** 路由来自该会话的模型选择（`modelDirectories` 里那条会话的 `current.provider`），不是 DSH 构建里注册的全部适配器——`listProviders()` 会报出 `deepseek-official`、`deepseek-account` 这类用户从未配置的内置供应商，显示它们只是噪音。

**读数可能落后**：一次自动查询失败但上次成功过时，读数仍显示上次的值并标注「可能已过期」，同时弹层里说明失败原因。不会把过期数字当作当前值。

## 收录的供应商

只查官方域名，不向任何其它地址发请求。

| 供应商 | 接口 | 计费 |
|---|---|---|
| DeepSeek | `GET /user/balance` | API 余额 |
| OpenRouter | `GET /api/v1/key` | API 余额 |
| Moonshot / Kimi | `GET /v1/users/me/balance` | API 余额 |
| SiliconFlow | `GET /v1/user/info` | API 余额 |
| 智谱 GLM / Z.AI | `GET /api/monitor/usage/quota/limit` | 订阅窗口 |
| Kimi Coding | `GET /coding/v1/usages` | 订阅窗口 |
| MiniMax | `GET /v1/token_plan/remains` | 订阅 |
| OpenCode Go | `GET /zen/go/v1/usage` | 订阅窗口 |

凭据变量按路由解析：优先取适配器声明的 `apiKeyEnv`，其次取 profile 的 `cordis.patch.yml` 里 `llm-*` 行的配置，最后回退到目录默认值（如 `DEEPSEEK_API_KEY`）。

## 查不到时的四级区分

本插件的核心承诺是**不猜数字**。任何非成功结果都落在以下之一，并说明下一步该做什么：

| 状态 | 含义 |
|---|---|
| `no-credential` | 凭据变量存在但没配值，指出去配哪个变量 |
| `unknown-provider` | **本插件未收录**这条路由，且预设接口链全部试过都没命中 —— 这不等于该供应商没有接口 |
| `no-public-endpoint` | 已收录，且该家确定没有公开余额接口 |
| `parse-failed` | 接口通了（HTTP 200）但响应结构不认识，**附原始响应片段** |

## 预设接口探测

路由不在内置目录里时**不会直接放弃**，而是按固定顺序试一组常见的中转站面板接口，哪个先返回可读数字就用哪个：

| 顺序 | 接口 | 出处 |
|---|---|---|
| 1 | `GET /api/usage/token/` | New-API ≥ v0.9.0，一次请求直出剩余额度 |
| 2 | `GET /v1/dashboard/billing/subscription` | OpenAI 风格，以美分计 |
| 3 | `GET /v1/usage` | Sub2API 系 |
| 4 | `GET /api/v1/me/quota` | claude-code-hub，用 `X-Api-Key` 头 |
| 5 | `GET /dashboard/billing/credit_grants` | CloseAI 系 |
| 6 | `GET /api/v1/credits` | — |
| 7 | `GET /api/user/self` | New-API 变体 |

第 1 条与第 7 条会先在**免认证**的 `GET /api/status` 读一次站点的 `quota_per_unit` 再换算 —— New-API 的记账单位站主可以改，硬编码 500000 会差若干个数量级。

**你设的自定义接口排在最前**：`balance_set_endpoint` 工具或 `routes[].endpoint` 配的值优先于全部预设，因为那才是你确知的东西。预设全都不对时，用这个填一条就能解决。

401 / 403 会**立即停止**整条链 —— 后续接口用的是同一个凭据，重试没有意义。

**能力边界要说清楚**：这套机制（顺序、短路、校准、回退）有测试覆盖，每条提取路径都有 fixture；但**各条预设的响应结构是从参考项目的面板清单转录的，作者无法逐家复验**。所以某条预设认不出时会走 `parse-failed` 并回显原始响应，而不是返回一个错数字。

## 内置目录的 id 别名

适配器会给自己的路由起 `deepseek-official`、`deepseek-account` 这类名字。这些会被剥掉后缀后匹配到对应供应商条目，而不是当作「未收录」——否则明明认识的供应商会被判成不认识。真正无关的 id（如 `deepseek-proxy`）仍按未收录处理。

`parse-failed` 会回显响应片段是刻意的：8 家的响应结构由各家文档整理而来，**作者没有这些供应商的密钥，无法在开发期逐家实测**。片段回显让你能直接看到实际返回并据此调整。

回显内容经遮蔽处理（`sk-…`、`Bearer …`、`{ "api_key": … }` 等一律替换为 `***`）并截断到 800 字符。

## 权限与隐私

- **不申请任何 exec 权限，不启动任何子进程。** 没有 `subprocess`、没有 shell、没有 `curl`。
- **请求只发往你在 DSH 里配置的那条路由自己的网关。** 没有任何第三方域名，没有遥测，没有回传。目录命中的路由只打它对应供应商的官方接口；目录未命中的路由只打它自己的 baseURL（见下方「预设接口探测」）。
- **密钥只用于该路由自己的网关。** 经 `ctx.credentials.resolve()` 读取，放进请求头，不落盘、不入日志、不进浏览器快照。快照里只有凭据**变量名**，没有值（有测试断言这一点）。
- **不写 DSH 的其它配置。** `balance_set_endpoint` 只改本插件自己那一行的 `config`。

## 配置

插件页 → `dsh-balance-meter` 卡片 → 配置表单：优先显示的路由、是否自动刷新、最小刷新间隔。

`routes[]` 覆盖（自定义接口、改凭据变量名）通过工具或直接编辑 profile 的 `cordis.patch.yml` 中 `balance-meter` 那一行：

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

接口模板支持两个占位符：`{origin}`（该路由的 scheme + host）与 `{base}`（该路由的 baseURL）。用 `{origin}` 更稳，因为它不受 baseURL 里带没带路径段影响。

## 工具

**`balance_check`** —— 参数 `{ route?, refresh? }`，返回结构化 JSON：路由、供应商、计费方式、状态、数值或额度窗口、接口地址、读取时间。未给 `route` 时查标题栏那条。

**`balance_set_endpoint`** —— 参数 `{ route, endpoint }`，把自定义接口写进本 profile 的 `cordis.patch.yml` 并立即生效；`endpoint` 传空字符串则清除覆盖。

> 写入 `routes` 会让该插件行走一遍 Loader 的正常生命周期（同义于重新装载），因此调用后插件的内存缓存会清空、标题栏读数会在下一次轮询时重新查询。这是 schemastery 的结构限制而非选择：它把数组元素一律视为 "blocked"，volatile 字段**不能**出现在数组里，而路由 id 是用户自定义的，所以没有任何 schema 形状能让路由覆盖成为 volatile 字段（volatile 才能原地更新、不重载）。

## 工作方式

```
DSH 宿主进程                                  浏览器
┌────────────────────────────────────┐       ┌────────────────────┐
│ dsh-balance-meter（宿主半）         │       │ dsh-balance-meter  │
│                                    │       │ （浏览器半）        │
│ ctx.llm.listProviders()  ─┐        │       │                    │
│ configEditor 的 llm-* 行  ─┼→ 路由  │       │  标题栏读数         │
│ 内置目录                  ─┘        │       │    ↓ fetch         │
│                        ↓           │       │  /api/balance-     │
│ ctx.credentials.resolve()          │       │   meter/snapshot   │
│                        ↓           │       │    ↑               │
│ fetch(供应商余额接口) → 解析 → 缓存  │──────→│    │               │
│                        ↓           │ JSON  │    │               │
│ ctx.tools.register ×2              │       │  配置表单           │
└────────────────────────────────────┘       └────────────────────┘
```

**刷新策略**：宿主半不持有定时器，也不在浏览器侧猜"一轮结束了没"。

- **每轮对话结束后**，宿主半监听会话日志的 `turn/end` 事件并刷新当前路由。这个事件名不是猜的——是从一个真实会话的 `session.v4.jsonl.zstd` 里读出来的（`{"type":"turn/end","data":{"turn":1,"reason":{…}}}`）。
- **浏览器半**每 10 秒取一次快照，那是**本地缓存读取，不触发供应商请求**；它只在一种情况下会查一次：这条路由**从未查过**（插件刚加载、或你刚切到另一个模型）。否则读数要等 `turn/end` 或你手动刷新。
- 供应商请求由 `minIntervalSec`（默认 30 秒）与失败冷却节流，所以密集的轮次不会变成密集的供应商请求。页面隐藏时不轮询。
- **一次失败的查询不会让读数变空**：宿主保留上一次成功的数值并在快照里标 `stale`，读数继续显示该数值并标注「可能已过期」，失败原因写在详情里。只有从未成功过时才显示「无法查询」。

**缓存与退避**：命中的接口地址按路由缓存；一次查询的全部候选都失败后进入 10 分钟冷却；同一路由的并发查询合并为一次在途请求。

## 与参考实现的已知差异

- **界面位置不同。** 参考项目在状态栏，本插件在输入框下方的状态行 —— DSH 的槽位体系里这就是 `conversation.composer.dock`，与内置的会话统计胶囊同一行。
- **状态行显示哪个窗口：按跨度由短到长。** 5 小时 → 每周 → 每月，取第一个有数字的。理由是这个顺序就是"哪道闸会先挡住你"：订阅是照最近的那个周期管理的。**不是**取剩余最少的窗口 —— 那会一直显示月度。若某家窗口名字看不出跨度，才退回"取剩余最少"。
- **未收录路由的提示是确定性的。** 预设链全都没命中时，如实说「本插件未收录」并附最后一次的原始响应，而不是伪造一个数字。

## 各家响应结构的实测状态

插件里 8 家的解析器写自各家文档，作者没有这些密钥，**只有 OpenCode Go 一家拿到了真实响应**并据此修正：

```json
{"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"…"},
          "weekly":{"status":"ok","percent":8,"resetsAt":"…"},
          "monthly":{"status":"ok","percent":53,"resetsAt":"…"}}}
```

这里的 `percent` 是**已用**占比，而不是剩余。这个判断有依据而非假设：实测账号在持续完成对话的同时 `rolling` 读到 `0`，不可能表示"剩余 0%"。插件据此换算剩余，并在窗口说明里保留原始值（`原始 percent=53`），万一本家日后改变约定也能一眼看出。

其余 7 家若结构与文档不符，会走「已连通·无法解析」并回显原始响应 —— 那时把回显发我即可修正。

## 开发

```sh
npm run verify   # 静态契约检查 + 全部测试
npm test         # 209 个测试，不需要装 DSH
npm run check    # 只跑静态契约检查
```

测试分三层，全部**不依赖 DSH**：

- **纯逻辑**（目录匹配与 id 别名、8 个响应解析器、7 条预设探测链、缓存/节流/冷却/合并、路由发现）—— 注入时钟与 fetch，结果确定
- **宿主半集成** —— 用桩替代 `@deepseek-ai/*` 包，跑真实的 `apply()`，覆盖工具注册、凭据解析、快照路由、配置写入
- **静态契约** —— `package.json` / `cordis.patch.yml` / 浏览器半的自洽性（裸导入是否已声明、bundle patch 是否指向本包、模块 id 是否等于包名、`files` 是否带上了入口文件）
- **schema 守卫**（`test/config-schema.test.mjs`）—— 用镜像了真实规则的桩校验器检查 `Config` 的 volatile 路径。这条规则必须镜像而不是放过：`Config` 结构违规不会让任何行为测试失败，只在用户安装时让插件整个不激活。`routes[].id` 曾经就是这样漏出去的。

设计规格见 [docs/superpowers/specs/2026-10-14-dsh-balance-meter-design.md](docs/superpowers/specs/2026-10-14-dsh-balance-meter-design.md)。

## 许可

MIT
