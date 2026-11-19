/**
 * 登录链路自检（离线，不需要真实上游）。
 *
 *   node scripts/logintest.mjs
 *
 * 起一个假上游，按设置页的真实路径跑一遍：
 * 发起登录 → 模拟浏览器回跳 → 换 Key → 落盘，以及两条失败路径
 * （code 被拒 / 连不上上游），确认回调页说的是真话。
 */

import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { apply } from "../lib/index.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------- 假上游

const VALID_CODE = "code-good";
const validKey = "key-abcdef123456";

const upstream = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const json = (status, payload) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  if (url.pathname === "/deepai_code/desktop_auth/exchange/" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let code = "";
    try {
      code = JSON.parse(Buffer.concat(chunks).toString("utf8")).code ?? "";
    } catch {
      code = "";
    }
    if (code === VALID_CODE) {
      json(200, { api_key: validKey, username: "tester", is_pro: false });
    } else {
      // 上游真实形状：error 是字符串
      json(400, { error: "invalid code" });
    }
    return;
  }
  if (url.pathname === "/deepai_code/models") {
    json(200, { data: [{ id: "fake-flash", name: "Fake Flash", theosPerRequest: "0" }] });
    return;
  }
  if (url.pathname === "/deepai_code/theos") {
    json(200, { balance: 1, granted: 1 });
    return;
  }
  if (url.pathname === "/deepai_code/desktop_auth/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>sign in</title>ok");
    return;
  }
  json(404, { error: { message: "not found", code: "not_found" } });
});

const upstreamPort = await new Promise((resolve) => {
  upstream.listen(0, "127.0.0.1", () => resolve(upstream.address().port));
});
const origin = `http://127.0.0.1:${upstreamPort}`;

// ---------------------------------------------------------------- 模拟 ctx

const routes = new Map();
const logs = [];
const ctx = {
  logger: {
    info: (m) => logs.push(["info", m]),
    warn: (m) => logs.push(["warn", m]),
    error: (m) => logs.push(["error", m])
  },
  llm: { registerAdapter() {} },
  inject(deps, fn) {
    if (!deps.includes("connection")) return () => {};
    fn({
      connection: {
        fetch: {
          register({ path, methods, fetch }) {
            for (const method of methods) routes.set(`${method} ${path}`, fetch);
            return () => {
              for (const method of methods) routes.delete(`${method} ${path}`);
            };
          }
        }
      }
    });
    return () => {};
  },
  emit() {}
};

const dataDir = await mkdtemp(join(tmpdir(), "deepai-login-"));
const result = apply(ctx, { apiOrigin: origin, dataDir, proxy: "" });
await result.ready;

const call = async (route, body) => {
  const handler = routes.get(route);
  if (handler === undefined) throw new Error(`路由不存在：${route}`);
  const response = await handler(
    body === undefined
      ? undefined
      : new Request("http://127.0.0.1/api/deepai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        })
  );
  return { status: response.status, data: await response.json() };
};

/** 发起登录，返回 { url, callbackPort, state } */
async function beginLogin() {
  const started = await call("POST /api/deepai/login", {});
  const url = started.data.url ?? "";
  const parsed = new URL(url);
  return {
    url,
    started,
    state: parsed.searchParams.get("state") ?? "",
    callbackPort: Number.parseInt(parsed.searchParams.get("port") ?? "", 10)
  };
}

async function hitCallback({ callbackPort, state, code }) {
  const target = `http://127.0.0.1:${callbackPort}/auth-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  const response = await fetch(target);
  return { status: response.status, html: await response.text() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  console.log("== 1. 发起登录 ==");
  const first = await beginLogin();
  check("login 返回 ok", first.started.data.ok === true, first.started.data.error ?? "");
  check("URL 指向配置的上游", first.url.startsWith(`${origin}/deepai_code/desktop_auth/`), first.url);
  check("URL 带 state", first.state.length >= 32);
  check("URL 带回调端口", Number.isInteger(first.callbackPort) && first.callbackPort > 0, String(first.callbackPort));

  console.log("\n== 2. state 不对 ==");
  const wrongState = await hitCallback({ callbackPort: first.callbackPort, state: "deadbeef", code: VALID_CODE });
  check("回调页 400", wrongState.status === 400, String(wrongState.status));
  check("提示参数不对", wrongState.html.includes("回调参数不对"));

  console.log("\n== 3. code 被上游拒绝 ==");
  const second = await beginLogin();
  const rejected = await hitCallback({ ...second, code: "code-bad" });
  check("回调页 400", rejected.status === 400, String(rejected.status));
  check("标题说「上游拒绝了这个授权 code」", rejected.html.includes("上游拒绝了这个授权 code"));
  check("不再写成「连不上上游」", !rejected.html.includes("连不上 DeepAI 上游"));
  check("错误正文是人话", rejected.html.includes("invalid code"), "含上游原文");
  await sleep(150);
  const afterReject = await call("GET /api/deepai/status");
  check("状态页留住了失败原因", String(afterReject.data.login?.error ?? "").includes("上游拒绝"), afterReject.data.login?.error ?? "");
  check("状态页没有残留 pending", afterReject.data.login?.pending === false);
  check("仍未登录", afterReject.data.signedIn === false);

  console.log("\n== 4. 正常换 Key ==");
  const third = await beginLogin();
  const success = await hitCallback({ ...third, code: VALID_CODE });
  check("回调页 200", success.status === 200, String(success.status));
  check("提示已授权", success.html.includes("已授权 DeepAI Code"));
  await sleep(200);
  const saved = JSON.parse(await readFile(join(dataDir, "account.json"), "utf8"));
  check("Key 已落盘", saved.apiKey === validKey, `${String(saved.apiKey).slice(0, 6)}…`);
  check("用户名已落盘", saved.username === "tester", saved.username);
  const afterOk = await call("GET /api/deepai/status");
  check("状态 signedIn", afterOk.data.signedIn === true);
  check("状态里没有残留错误", (afterOk.data.login?.error ?? "") === "", afterOk.data.login?.error ?? "");
  check("出口信息存在", typeof afterOk.data.egress?.mode === "string", `${afterOk.data.egress?.mode}`);
  check("模型目录来自假上游", (afterOk.data.models ?? []).some((m) => m.id === "fake-flash"));

  console.log("\n== 5. 连不上上游 ==");
  await new Promise((resolve) => upstream.close(resolve));
  const fourth = await beginLogin();
  const offline = await hitCallback({ ...fourth, code: VALID_CODE });
  check("回调页 502", offline.status === 502, String(offline.status));
  check("标题说「连不上 DeepAI 上游」", offline.html.includes("连不上 DeepAI 上游"));
  check("不再甩给 code", !offline.html.includes("上游拒绝了这个授权 code"));
  check("带上排查提示", offline.html.includes("出口代理"));
  await sleep(150);
  const afterOffline = await call("GET /api/deepai/status");
  check("状态页记下网络失败", (afterOffline.data.login?.error ?? "") !== "", afterOffline.data.login?.error ?? "");
} catch (error) {
  failures += 1;
  console.error("  FAIL 未捕获异常 —", error?.stack ?? String(error));
} finally {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${failures === 0 ? "登录链路全部通过" : `${failures} 项失败`}`);
for (const [level, message] of logs) {
  if (level !== "info") console.log(`  [${level}] ${message}`);
}
process.exit(failures === 0 ? 0 : 1);
