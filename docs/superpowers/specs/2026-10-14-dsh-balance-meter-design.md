# dsh-balance-meter — 设计规格

- 日期：2026-10-14
- 参考项目：`E:\ccgui-plugin\plugin-balance-meter`（CC GUI 插件，作为功能对照，不作代码复用）
- 目标：为 DeepSeek Harness（DSH）做一个原生插件，按当前路由识别供应商与计费方式，查询 API 余额或订阅余量

---

## 1. 问题与范围

参考项目在 CC GUI 上做同样的事，但 CC GUI 的插件模型迫使它付出了几项代价：网络出口只能经 `exec:curl`、宿主 HTTP 出口要求预先声明具体域名、读凭据要自己解析各引擎的配置文件、识别路由要嗅探网关域名。DSH 提供同类能力的原生服务，因此本插件：

- **不申请任何 exec 权限**，不启动任何子进程
- **不发任何未识别域名的请求**（只查内置目录里那 8 家的官方域名）
- 凭据只经 `ctx.credentials` 读取，密钥不落盘、不入日志、不发给任何第三方

**在范围内**：8 家供应商的余额/余量查询 · 标题栏读数 · 模型可调用的工具 · 配置面 · 四级"查不到"提示。

**不在范围内**（明确不做）：中转站探测链 · shell/exec · systemPrompt 每轮注入 · 侧边栏整页 · 设置页区块 · 启动时版本检查 · 写任何 DSH 配置文件之外的东西。

---

## 2. 已验证的宿主能力

以下事实来自本机 DSH 安装（`D:\DeepSeek Harness`，profile `desktop`），实施时不得凭记忆改写字段名。

| 能力 | API | 来源 |
|---|---|---|
| 注册工具 | `defineTool()` + `ctx.tools.register()` | `@deepseek-ai/dsh-tools` README |
| 读凭据 | `ctx.credentials.resolve(credentialRef(NAME))` → `{value, source} \| undefined` | `@deepseek-ai/dsh-credentials` README |
| 枚举路由 | `ctx.llm.listProviders()` → 已注册 provider 元数据数组 | `@deepseek-ai/dsh-llm` lib |
| 凭据变量声明 | 配置字段 `z.string().role('credential-ref')` | `dsh-llm-deepseek/lib/index.js` |
| 宿主开 HTTP 路由 | `ctx.connection.fetch.register({path, methods, requestBody, fetch})` | `dsh-client-file-upload/lib/index.js` |
| 标题栏挂件 | slot `conversation.session.header.utilities`（kind `list`） | `dsh-client-ui-open-in-app/lib/client.js` |
| 插件配置表单 | slot `plugins.bundle.config`，键为包名 | godot-bridge `client/client.js` |
| 安装 | `dsh plugin --profile desktop add <路径>` | godot-bridge README |

**插件形态**（照 godot-bridge 这个已在本机跑通的 DSH 插件）：

```
package.json        dsh.bundle.patch 指向 cordis.patch.yml；dsh.client 声明浏览器半
cordis.patch.yml    bundle 层：插入本插件的 Loader 行
plugin/index.mjs    宿主半（Node / cordis 插件）
client/client.js    浏览器半（window.__ModuleLoader__.load，只能 require 平台种子模块）
```

**必须遵守**：宿主半是真正的 Node ESM 包，可用相对导入与 `@deepseek-ai/*` 裸导入；浏览器半是单文件、无构建、除平台种子（`react` 等）外不得 require 任何模块。

---

## 3. 供应商目录

8 家。接口路径与响应结构来自参考项目 README（其标注为 2026-10 复核），**本项目作者没有这些供应商的密钥，无法在开发期实测**——因此第 6 节的解析失败降级不是可选项。

| id | 默认 baseURL | 凭据变量 | 接口 | 计费 |
|---|---|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `GET /user/balance` | API 余额 |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `GET /key` | API 余额 |
| `moonshot` | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | `GET /users/me/balance` | API 余额 |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | `GET /user/info` | API 余额 |
| `zhipu` | `https://open.bigmodel.cn/api` | `ZHIPU_API_KEY` | `GET /monitor/usage/quota/limit` | 订阅窗口 |
| `kimi-coding` | `https://api.kimi.com` | `KIMI_API_KEY` | `GET /coding/v1/usages` | 订阅窗口 |
| `minimax` | `https://api.minimaxi.com` | `MINIMAX_API_KEY` | `GET /v1/token_plan/remains` | 订阅 |
| `opencode-go` | `https://opencode.ai` | `OPENCODE_GO_API_KEY` | `GET /zen/go/v1/usage` | 订阅窗口 |

每条目录项声明：`id` · `label` · `hosts[]`（用于按 baseURL 主机名匹配，含别名域名）· `baseURL` · `env[]`（凭据变量候选，按序尝试）· `endpoint` · `billing`（`api` \| `subscription`）· `adapter`（解析器名）· `note`（无接口/需特殊说明时的确定性文案）。

**匹配顺序**：
1. 路由 id 与目录 `id` 精确相等
2. 路由 baseURL 的主机名落在某目录项的 `hosts[]`
3. 都未命中 → `unknown-provider`（"本插件未收录"），**不**报"官方未提供接口"

---

## 4. 路由识别

按用户决定：**服务枚举为主，配置文件为兜底**。

1. `ctx.llm.listProviders()` → 已注册路由（含 id 与适配器暴露的元数据）
2. 若某路由的 baseURL 未由适配器暴露，回退解析 profile 的 `cordis.patch.yml` 中 `llm-*` 行的 `baseURL` / `apiKeyEnv`
   - profile 根：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`（`$DSH_HOME` 默认 `~/.dsh`；本机另有 `%LOCALAPPDATA%\Penglai\0.5\dsh-home`，两者都探测）
   - 该文件格式属 DSH 内部实现。解析必须是**只读、容错**的：任何异常都降级为"该路由信息不可用"，绝不抛出、绝不写入
3. 插件 `Config.routes[]` 中的用户覆盖优先级最高

**配置兜底只用于读 baseURL 与凭据变量名，不读密钥。** 密钥一律经 `ctx.credentials` 解析。

---

## 5. 缓存与刷新

**先澄清"探测"的边界**：目录里 8 家各只有一个已知接口，所以对目录供应商**不存在多候选探测**。候选只有一个时，失败即按第 6 节分类报告，**不尝试其它路径**——这与参考项目对中转站的探测链是两回事，不要照搬。

只有在用户于 `Config.routes[]` 里给某路由填了 `endpoint` 时，该路由才有两个候选（目录默认 + 用户自定义），按序尝试。

| 项 | 规则 |
|---|---|
| 接口地址缓存 | 按路由（主机 + 路径）缓存本次命中的候选地址，后续直用 |
| 失败退避 | 一次查询的全部候选都失败后，该路由进入 10 分钟冷却；手动刷新强制重试并清除冷却 |
| 自动刷新 | 每轮对话结束触发；同一路由两次之间至少间隔 `minIntervalSec`（默认 30 秒） |
| 查询合并 | 同一路由并发查询合并为一次在途请求，避免 chip 轮询与自动刷新撞车 |
| 快照 | 客户端读的是缓存快照，`fetch` 路由本身不触发查询（除非带 `?refresh=1`） |

---

## 6. "查不到"的四级确定性

参考项目的核心承诺是**不猜数字**。任何非成功结果都必须落入且只落入以下之一：

| 级别 | 触发条件 | 文案要点 |
|---|---|---|
| `no-credential` | 凭据变量存在，但 `credentials.resolve` 返回 undefined | 指名要配哪个变量、去哪儿配 |
| `unknown-provider` | 路由未命中目录 | "本插件未收录"，并说清这不等于官方没有接口 |
| `no-public-endpoint` | 命中目录但该家确定无余额接口 | 目录项的 `note` 文案 |
| `parse-failed` | HTTP 200，但响应结构不认识 | **附原始响应片段**（截断 + 剔除疑似密钥的字段） |

`parse-failed` 附原始响应是刻意的：8 家的响应结构我无法在开发期实测，这是让用户能自行诊断的唯一途径。截断到固定字节数，并对响应里形如 `sk-…` 的串做遮蔽。

---

## 7. 配置面

宿主半 `Config`（`@deepseek-ai/schemastery`），自动投影为插件页表单：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `routes` | array | `[]` | 用户覆盖：`{ id, baseURL, apiKeyEnv, endpoint }`，留空项用目录默认 |
| `primary` | string | `''` | 标题栏 chip 显示哪条路由；留空取 DSH 默认模型的路由 |
| `autoRefresh` | boolean | `true` | 每轮对话后自动刷新 |
| `minIntervalSec` | number | `30` | 自动刷新节流间隔 |

另注册 `balance_set_endpoint` 工具，把某路由的自定义接口写回 profile 的 `cordis.patch.yml`（对齐 godot-bridge 的 `godot_set_engine_path` 模式：经 `ctx.configEditor.edit` 立即生效、无需重启）。**该工具只改本插件自己那一行的 config。**

**客户端附带**注册 `plugins.bundle.config` 表单，使上述配置可在 GUI 编辑（配置入口，非展示位）。用户只选了标题栏读数；若不要此表单，配置就须手改 `cordis.patch.yml`。

---

## 8. 界面

**标题栏 chip** —— slot `conversation.session.header.utilities`，`inject: (sessionId) => props`。

- 常态：`余额 ¥12.34` / `余量 62%` / `无法查询`
- 点击：popover 列出全部路由 + 各自计费方式、接口地址、最近查询时间，附「立即刷新」
- 数据：`fetch('/api/balance-meter/snapshot')`
- 样式：只用宿主 `--dsw-alias-*` token，随主题变化只降级观感、不崩渲染
- 文案：注册 `ctx.locale` 字典，`zh-CN` + `en`

**已知开放项 —— 当前会话的路由**：slot 能拿到 `sessionId`，但宿主侧"按会话解析模型"的稳定 API 未在开发期确认到。设计取值顺序：`Config.primary` → DSH 默认模型的路由。会话级覆盖若实施时验证到便宜 API 则补上；否则 chip 显默认路由、popover 列全部路由。**不接受"假装知道会话路由却显示错的路由"。**

---

## 9. 工具

`balance_check` —— 参数 `{ route?: string, refresh?: boolean }`。返回结构化 JSON：

```
{ route, provider, label, billing, status, balance?, quota?, endpoint, queriedAt, message? }
```

`status` ∈ `ok` | `no-credential` | `unknown-provider` | `no-public-endpoint` | `parse-failed` | `network-error` | `http-error`。

工具描述里写明：查不到时如实转述 `message`，不得推断或编造数字。

**不加 systemPrompt 段**（用户选择：平时不占系统提示词成本）。

---

## 10. 错误处理原则

- 宿主半 `apply()` 内任何可选服务的缺失都降级为"该功能不可用 + 指引"，**绝不 throw**（照 godot-bridge 的做法：注册漂移必须降级，不能带崩整个插件）
- `ctx.connection.fetch.register` 的路由对本插件的浏览器半是只读快照；查询失败在快照里以 `status` 表达，不返回 5xx
- 所有出网请求带超时（默认 8 秒）与 `AbortSignal`
- 凭据值只在请求头里出现；日志与快照只记录"是否已配置"，不记录值

---

## 11. 测试与验收

**不依赖 DSH 即可运行**（`node --test`）：

- 目录匹配：id 精确、主机名匹配、别名域名、未命中
- 8 个供应商解析器：各一份固定 fixture → 归一化结果
- 四级降级分类：每种触发条件各一例
- 响应遮蔽：`sk-…` 被遮蔽、超长响应被截断
- 节流与退避：间隔内不重查、冷却期内不重试、手动刷新清冷却
- 查询合并：并发调用只发一次在途请求

**静态契约检查**（`node scripts/check-plugin-contract.mjs`，不需要 DSH）：

- `peerDependencies` 覆盖宿主半的每条 `@deepseek-ai/*` 裸导入
- `cordis.patch.yml` 存在且引用本包名
- `package.json` 的 `main`/`exports["."]`/`exports["./client"]` 指向存在的文件且导出齐全
- 浏览器半契约：`__ModuleLoader__.load` 的 `id` 等于包名、无 `require()` 平台种子之外的模块、`plugins.bundle.config` 的键等于包名

**端到端**（由用户在 DSH 里验收，我不代劳）：

1. `dsh plugin --profile desktop add E:\订阅余量查看`
2. 重启 DSH，确认插件页出现本插件卡片、标题栏 chip 出现
3. 让模型调用 `balance_check`，确认能答出余额或如实转述查不到的原因

---

## 12. 交付

- 插件根目录：`E:\订阅余量查看`
- 新建 GitHub 仓库并推送（用户已授权）
- README（中英）说明：装什么、怎么装、怎么再装一次、怎么卸载、权限边界（不执行子进程、只查目录内域名、密钥不外发）
