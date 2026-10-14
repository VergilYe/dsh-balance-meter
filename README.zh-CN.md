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

**标题栏读数** —— 当前路由的余额或余量；点开是详情弹层：

- 每条路由的供应商、计费方式、可读到的数值或额度窗口
- 查询用的接口地址、最近读取时间、凭据变量名
- 「立即刷新」按钮（跳过失败冷却，重查全部路由）

**读数可能落后**：一次自动查询失败但上次成功过时，读数仍显示上次的值并带一个「·」标记，同时弹层里说明失败原因。不会把过期数字当作当前值。

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
| `unknown-provider` | **本插件未收录**这条路由 —— 这不等于该供应商没有接口 |
| `no-public-endpoint` | 已收录，且该家确定没有公开余额接口 |
| `parse-failed` | 接口通了（HTTP 200）但响应结构不认识，**附原始响应片段** |

`parse-failed` 会回显响应片段是刻意的：8 家的响应结构由各家文档整理而来，**作者没有这些供应商的密钥，无法在开发期逐家实测**。片段回显让你能直接看到实际返回并据此调整。

回显内容经遮蔽处理（`sk-…`、`Bearer …`、`{ "api_key": … }` 等一律替换为 `***`）并截断到 800 字符。

## 权限与隐私

- **不申请任何 exec 权限，不启动任何子进程。** 没有 `subprocess`、没有 shell、没有 `curl`。
- **只连目录里那 8 家的官方域名。** 路由不在目录里时不会退化成"试试看"，而是报告 `unknown-provider`。
- **密钥只用于该路由自己的供应商。** 经 `ctx.credentials.resolve()` 读取，放进请求头，不落盘、不入日志、不进浏览器快照。快照里只有凭据**变量名**，没有值（有测试断言这一点）。
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

**刷新策略**：宿主半不持有定时器。浏览器半按 60 秒轮询快照接口，由宿主半决定这次轮询能否真的变成一次供应商请求（受 `minIntervalSec` 与失败冷却约束）。时钟放在浏览器侧少了一整类生命周期 bug，而新鲜度只有那个读数关心，读数也只在页面可见时存在。页面隐藏时不轮询。

**缓存与退避**：命中的接口地址按路由缓存；一次查询的全部候选都失败后进入 10 分钟冷却；同一路由的并发查询合并为一次在途请求。

## 与参考实现的已知差异

- **自动刷新由轮询驱动，不是"每轮对话后"。** 参考项目挂在 `usage://done` 上。DSH 的会话事件词汇没有公开文档，我没有在真实会话里观测到它，因此没有写一个猜出来的监听器 —— 那会在每次会话事件上误触发。等事件形状确认后这是一个很小的增量改动。
- **读数显示的是主路由，不是"当前会话的路由"。** 标题栏 slot 能拿到 `sessionId`，但宿主侧按会话解析模型的稳定 API 未确认。取值顺序为配置的 `primary` → 目录里第一条可识别路由。宁可显示默认路由，也不假装知道会话路由却显示错的。
- **不含中转站探测链。** 参考项目有 7 条探测链处理未识别的中转站。本版本只查目录内域名 —— 这是刻意的取舍：向未知域名发请求会让"只连官方域名"的保证失效。

## 开发

```sh
npm run verify   # 静态契约检查 + 全部测试
npm test         # 160 个测试，不需要装 DSH
npm run check    # 只跑静态契约检查
```

测试分三层，全部**不依赖 DSH**：

- **纯逻辑**（目录匹配、8 个响应解析器、缓存/节流/冷却/合并、路由发现）—— 注入时钟与 fetch，结果确定
- **宿主半集成** —— 用桩替代 `@deepseek-ai/*` 包，跑真实的 `apply()`，覆盖工具注册、凭据解析、快照路由、配置写入
- **静态契约** —— `package.json` / `cordis.patch.yml` / 浏览器半的自洽性（裸导入是否已声明、bundle patch 是否指向本包、模块 id 是否等于包名、`files` 是否带上了入口文件）
- **schema 守卫**（`test/config-schema.test.mjs`）—— 用镜像了真实规则的桩校验器检查 `Config` 的 volatile 路径。这条规则必须镜像而不是放过：`Config` 结构违规不会让任何行为测试失败，只在用户安装时让插件整个不激活。`routes[].id` 曾经就是这样漏出去的。

设计规格见 [docs/superpowers/specs/2026-10-14-dsh-balance-meter-design.md](docs/superpowers/specs/2026-10-14-dsh-balance-meter-design.md)。

## 许可

MIT
