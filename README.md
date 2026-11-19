# dsh-deepai-freemodel

> GitHub: <https://github.com/cheungray123/dsh-deepai-freemodel>

把 **DeepAI Code** 的模型接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），
模型选择器里多出一个 `DeepAI Code` provider。

- 浏览器 OAuth 登录，Key 落盘复用；走不通时可手动填 API Key
- 直连上游 HTTP 接口，不装桌面客户端、不起网关进程、不占固定端口
- 网络被墙时**自己找本机代理**并走 CONNECT 隧道，不用设环境变量
- 流式输出、thinking、工具调用、图片输入；超长对话发送前自动收敛
- 设置页带诊断面板与分步连通自检

## 安装

**设置 → 插件 → 添加插件**，填包名 `dsh-deepai-freemodel`，或仓库地址
`https://github.com/cheungray123/dsh-deepai-freemodel`。命令行：

```bash
dsh plugin add dsh-deepai-freemodel
```

> 走 npmmirror 时可能只拉到占位版本（报「这个包没有声明组合包」）：把安装源切到 npm 官方源，
> 或命令行加 `--registry=https://registry.npmjs.org`。

装好到 **设置 → DeepAI 免费模型** 点「用浏览器登录」。上游只认 Google / Apple 登录的账号，
邮箱注册的号会被 `403 social_login_required` 拒绝。

## 网络与代理

`api.deepai.org` 在部分网络下会被 DNS 污染或阻断。典型症状：**浏览器能打开登录页、能拿到 code，
插件却报「连不上上游」**——浏览器走系统 PAC，插件跑在 Node 里，走的是另一条路。

插件自带出口选择，按下面的顺序决定（结果见设置页「连接诊断 → 出口代理」）：

1. 配置 `proxy` 或环境变量 `DEEPAI_PROXY` —— 显式指定，优先；
2. `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` —— 交给 Node 内置 fetch；
3. 自动：先探直连，不通就认本机代理（注册表 `ProxyServer`、PAC 脚本、
   10808 / 10809 / 7890 / 7897 / 1080 等常见端口），认出后用自带 CONNECT 隧道发请求，并按长连接复用。

本机开着代理客户端时通常什么都不用配。要固定用某个代理：

```yaml
- id: deepai
  name: dsh-deepai-freemodel
  config:
    proxy: http://127.0.0.1:10808   # 也可只写 127.0.0.1:10808
```

> 隧道只作用于本插件的上游请求，不会把 DSH 其它请求绕进代理。
> 只支持 HTTP/HTTPS 代理（CONNECT）；SOCKS 需代理客户端另开 HTTP 入站口。

## 配置

全部可省略，改 profile 的 `cordis.patch.yml`：

| 配置项 | 环境变量 | 说明 |
| --- | --- | --- |
| `providerId` | — | provider id，默认 `deepai` |
| `displayName` | — | 选择器里的分组名 |
| `dataDir` | `DEEPAI_DATA_DIR` | 凭据与状态目录，默认 `~/.dsh-deepai-freemodel` |
| `apiOrigin` | `DEEPAI_API_ORIGIN` | 上游地址，自建反代用 |
| `proxy` | `DEEPAI_PROXY` | 显式指定本机代理 |
| — | `DEEPAI_MACHINE_ID` | 显式机器指纹，替代自动探测 |
| — | `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` | 让 Node 内置 fetch 走代理（可选） |

## 授权失败怎么排查

回调页按原因分两种标题，别混：

| 标题 | 含义 | 下一步 |
| --- | --- | --- |
| 连不上 DeepAI 上游 | 请求根本没发到上游（DNS 污染 / 直连被阻断 / 代理没起来） | 看设置里的「出口代理」，必要时显式配 `proxy` |
| 上游拒绝了这个授权 code | 请求到了上游，但 code 失效或已被用过 | 回设置页重新点「用浏览器登录」 |

失败原文同时留在设置页（`login.error` / `login.hint`），不用回浏览器窗口找。

## 落盘文件

`~/.dsh-deepai-freemodel/`：`account.json`（Key、用户名、授权时间，权限 0600）、
`state.json`（车道版本、模型目录缓存）。按 mtime 热重载，改完不用重启 DSH。

## 上游协议要点

改代码前先看，这些是实测踩出来的：

- 头必须原样发 `User-Agent: node` / `Accept: */*` / `Accept-Language: *` / `Sec-Fetch-Mode: cors`；
  带完整 Chrome 头反而会被判成非客户端。
- `X-DeepAI-Code-Theos` 是车道号，上游抬版本后旧值一律回 `426`；试出的结果会落盘，只付一次探测成本。
- 每个 chat 请求必须带 `system` 消息，否则 `400`；`/models` 免鉴权，但失效 Key 会 `302` 到登录页，
  所以必须 `redirect: "manual"`。
- `/theos` 签到（回传 `check_in.nonce`）影响请求是否被当成真客户端，失败不阻塞推理。
- 免费额度按**出口 IP** 计，`network_bound` 不是插件问题。
- 上游会偶发 `400 The model provider rejected this request.`，同一份报文重发就正常
  （归为 `provider`，自动重试 3 次，别当成「请求体不合法」）。
- 目录写着 320k 上下文，但单次请求约超 4~5 万 token 后上游会**静默丢掉较早的消息**。
  插件发送前会收敛（`fitChatBody`），始终保留最初的 user 任务与最近上下文；统计见 `contextFit` 字段。

## 自检脚本

```bash
node scripts/selftest.mjs      # 协议 + 存储 + 上游 + 端到端（需凭据）
node scripts/streamtest.mjs    # SSE 解析与流式输出（需凭据）
node scripts/adaptertest.mjs   # 按 DSH 调用方式跑 prepareCall/stream（需凭据）
node scripts/plugintest.mjs    # 模拟 cordis ctx 驱动 apply() 与全部路由
node scripts/protocoltest.mjs  # 离线：JSON 文本归一化与 auto-review
node scripts/proxytest.mjs     # 离线：隧道、连接复用、SSE、出口互备
node scripts/logintest.mjs     # 离线：登录 → 回跳 → 换 Key，含两条失败路径
```

## 许可

MIT
