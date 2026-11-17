# dsh-deepai-freemodel

> GitHub: <https://github.com/cheungray123/dsh-deepai-freemodel>

把 **DeepAI Code** 的模型接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），
在模型选择器里多出一个 `DeepAI Code` provider，上游免费额度的模型会标上「· 免费」。

- 浏览器 OAuth 登录，Key 落盘复用，之后不用重复授权
- 直连上游 HTTP 接口，**不装桌面客户端、不起网关进程、不占固定端口**
- 流式输出、推理内容（thinking）、工具调用、图片输入全支持
- 设置页内置诊断面板与分步连通自检，出错时能指到具体环节
- 浏览器授权走不通时，可以手动填 API Key 兜底

## 安装

在 DSH 里打开 **设置 → 插件 → 添加插件**，填入包名 `dsh-deepai-freemodel`（从 npm 安装），
或 GitHub 仓库地址 `https://github.com/cheungray123/dsh-deepai-freemodel`，
或本包所在的本地目录。

装好后在 **设置 → DeepAI 免费模型** 点「用浏览器登录」，用 Google 账号完成一次授权。

> 上游只接受 Google / Apple 登录的账号。邮箱密码注册的账号会被 `403 social_login_required` 拒绝，
> 换号或重试都无效。

## 网络要求

`api.deepai.org` 在部分网络下会被 DNS 污染或直接阻断，表现为 `fetch failed` 或一直超时。
插件本身不实现代理，走 Node 内置代理支持，需要两个环境变量：

```powershell
setx NODE_USE_ENV_PROXY 1
setx HTTPS_PROXY http://127.0.0.1:10808
setx NO_PROXY 127.0.0.1,localhost,::1
```

设完要**重启 DSH**（它由 explorer 启动，不会继承新变量）。

设置页的诊断面板会显示当前出口代理是否被识别。

## 设置页能做什么

| 区块 | 用途 |
| --- | --- |
| 账号 | 登录 / 重新授权 / 退出，显示当前账号、套餐、Key 打码 |
| 连接诊断 | 车道版本、机器指纹、目录来源、出口代理、最近错误 |
| 连通自检 | 逐步跑「指纹 → 凭据 → 车道 → 目录 → 推理」，每步带耗时与失败原因 |
| 可用模型 | 上游实时目录，支持筛选，标注免费 / 图像 / 思考 |

## 配置

全都可以不填。需要时改 profile 的 `cordis.patch.yml`：

```yaml
- id: deepai
  name: dsh-deepai-freemodel
  config:
    providerId: deepai          # provider id
    displayName: DeepAI Code    # 选择器里的分组名
    dataDir: ~/.dsh-deepai-freemodel
    apiOrigin: https://api.deepai.org
```

环境变量覆盖：

| 变量 | 作用 |
| --- | --- |
| `DEEPAI_DATA_DIR` | 凭据与状态目录 |
| `DEEPAI_API_ORIGIN` | 上游地址（自建反代用） |
| `DEEPAI_MACHINE_ID` | 显式指定机器指纹原始值，替代自动探测 |
| `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` | 走代理 |

## 落盘文件

都在 `~/.dsh-deepai-freemodel/`：

- `account.json` — API Key、用户名、授权时间（权限 0600）
- `state.json` — 学到的车道版本与模型目录缓存

两个文件都按 mtime 热重载，手工改完不用重启 DSH。

## 上游协议要点

这些是踩出来的，改代码时别动：

- 请求头必须原样发 `User-Agent: node` / `Accept: */*` / `Accept-Language: *` / `Sec-Fetch-Mode: cors`。
  加上更完整的 Chrome 头反而会被判定成非客户端。
- `X-DeepAI-Code-Theos` 是车道号，上游抬版本时旧值一律回 `426`。插件会试候选并**把结果落盘**，
  所以只在协议变更后付一次探测成本。
- 每个 chat 请求都必须带 `system` 消息，否则 `400`。
- `/models` 免鉴权，是最便宜的车道探针；但对失效 Key 会 `302` 到登录页，所以必须 `redirect: "manual"`，
  否则鉴权失败会被伪装成 `200`。
- 推理前的 `/theos` 签到（回传 `check_in.nonce`）影响请求是否被当作真客户端。签到失败不阻塞推理。
- 免费额度按**出口 IP** 计，`network_bound` 不是插件问题。
- 上游后端会**偶发**返回 `400 The model provider rejected this request.`，同一份报文重发就正常
  （已实测：相同 body 前一次 400、后一次 200）。这类错误归为 `provider`，插件会自动重试 3 次，
  不要把它当成「请求体不合法」——那会走到错误的处理分支。

## 自检脚本

```bash
node scripts/selftest.mjs      # 协议 + 存储 + 上游 + 端到端
node scripts/streamtest.mjs    # SSE 解析与流式输出
node scripts/adaptertest.mjs   # 按 DSH 调用方式跑 prepareCall/stream，含工具调用
node scripts/plugintest.mjs    # 模拟 cordis ctx 驱动 apply() 与全部路由
```

前三个需要真实凭据；`plugintest` 用模拟 ctx，同样会打真实上游。

## 许可

MIT
