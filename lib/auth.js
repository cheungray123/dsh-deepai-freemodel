/**
 * 浏览器 OAuth：起一个 127.0.0.1 回环服务接住 `?code=`,
 * 再拿 code 换 API Key。
 *
 * 回环地址只在登录期间存在，回调处理完立刻关掉。
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const LOGIN_TTL_MS = 10 * 60 * 1_000;

/**
 * 换取 Key 的失败原因。
 *
 * 必须把「网络没通」和「code 被拒」分开：两者的下一步动作完全不同——
 * 前者去查代理，后者回设置页重来一次。混在一起只会让人以为 code 有问题。
 *
 * - `network`  传输层失败，请求根本没到上游
 * - `rejected` 上游明确拒绝了这次 code
 */
export class ExchangeError extends Error {
  constructor(kind, message, { hint, status } = {}) {
    super(message);
    this.name = "ExchangeError";
    this.kind = kind;
    this.hint = hint;
    this.status = status;
  }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function page(title, detail, tone = "ok") {
  const accent = tone === "ok" ? "#1f8f4e" : "#c0392b";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepAI Code</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
font:15px/1.7 -apple-system,'Segoe UI',system-ui,sans-serif;background:#0f1115;color:#e6e8eb">
<div style="max-width:440px;padding:32px;border-radius:14px;background:#171a21;border:1px solid #262b35">
<div style="font-size:17px;font-weight:600;margin-bottom:10px;color:${accent}">${title}</div>
<div style="font-size:13px;color:#a4abb8">${detail}</div>
</div>
<script>setTimeout(function(){try{window.close()}catch(e){}},1600)</script>
</body></html>`;
}

/**
 * 发起一次登录。
 *
 * @returns {{
 *   ready: () => Promise<string>,
 *   wait: () => Promise<{apiKey:string,username:string,isPro:boolean,obtainedAt:string}>,
 *   cancel: (reason?: string) => void,
 *   dispose: () => void
 * }}
 */
export function startSignIn({ signInUrl, exchange }) {
  const state = randomBytes(32).toString("hex");
  let server;
  let timer;
  let finished = false;
  let resolveDone;
  let rejectDone;

  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // 无人 await 时不要因为未捕获拒绝而炸掉进程
  done.catch(() => {});

  const shutdown = () => {
    if (server === undefined) return;
    try {
      server.close();
    } catch {
      /* 已经关了 */
    }
    server = undefined;
  };

  const finish = (fn) => {
    if (finished) return;
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    shutdown();
    fn();
  };

  const portReady = new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/auth-callback") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const gotState = url.searchParams.get("state") ?? "";
      const bad = req.method !== "GET" || code === "" || code.length > 4096 || !safeEqual(gotState, state);
      if (bad) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
          .end(page("回调参数不对", "这次授权链接可能已失效。回到设置页重新点「登录」再试一次。", "err"));
        return;
      }
      exchange(code)
        .then((account) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
            .end(page("已授权 DeepAI Code", "可以关闭这个页面，回到 DSH 设置页继续。"));
          finish(() => resolveDone(account));
        })
        .catch((error) => {
          const failure = describeExchangeFailure(error);
          res.writeHead(failure.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
            .end(page(failure.title, failure.detail, "err"));
          finish(() => rejectDone(error));
        });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("无法取得回调端口"));
    });
  });
  portReady.catch(() => {});

  timer = setTimeout(() => {
    finish(() => rejectDone(new Error("授权超时（10 分钟），请重新发起")));
  }, LOGIN_TTL_MS);
  timer.unref?.();

  return {
    async ready() {
      const port = await portReady;
      const target = new URL(signInUrl);
      target.searchParams.set("state", state);
      target.searchParams.set("port", String(port));
      return target.toString();
    },
    wait: () => done,
    cancel(reason = "授权已取消") {
      finish(() => rejectDone(new Error(reason)));
    },
    dispose() {
      finish(() => rejectDone(new Error("授权窗口已关闭")));
    }
  };
}

function describeExchangeFailure(error) {
  const kind = error instanceof ExchangeError ? error.kind : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof ExchangeError ? error.hint : undefined;
  const hintLine = typeof hint === "string" && hint !== "" ? `<br><br>${escapeHtml(hint)}` : "";

  if (kind === "network") {
    return {
      status: 502,
      title: "连不上 DeepAI 上游",
      detail:
        `${escapeHtml(message)}${hintLine}<br><br>` +
        "浏览器能打开登录页，只说明浏览器的网络通；插件进程走的是另一条路。" +
        "回到设置页看「出口代理」：如果显示「直连」而登录一直失败，" +
        "就填一个本机代理地址（插件配置的 <code>proxy</code>，或环境变量 <code>DEEPAI_PROXY</code>）再试。"
    };
  }
  if (kind === "rejected") {
    return {
      status: 400,
      title: "上游拒绝了这个授权 code",
      detail:
        `${escapeHtml(message)}${hintLine}<br><br>` +
        "code 只能换一次，放久了也会失效。回到设置页重新点「用浏览器登录」再试一次。"
    };
  }
  return { status: 502, title: "换取授权失败", detail: `${escapeHtml(message)}${hintLine}` };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
