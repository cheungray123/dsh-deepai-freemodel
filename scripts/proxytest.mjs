/**
 * 代理隧道自检（完全离线，不需要凭据）。
 *
 *   node scripts/proxytest.mjs
 *
 * 起一个本地 SSE 源站 + 一个本地 CONNECT 代理，验证：
 * 地址解析、CONNECT 握手、TLS 之外的请求/响应、POST 正文、
 * 重定向（manual / follow）、SSE 逐帧流式、以及出口失败后的互备。
 */

import { createServer as createHttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import process from "node:process";

import { parseProxyUrl, tcpOpen, tunnelReachable, tunnelRequest } from "../lib/proxy.js";
import { configureEgress, egressInfo, send } from "../lib/net.js";
import { sseFrames, toStreamChunks } from "../lib/protocol.js";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ 本地源站

function startOrigin() {
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, path: url.pathname }));
      return;
    }
    if (url.pathname === "/echo") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: request.method,
          body: Buffer.concat(chunks).toString("utf8"),
          contentType: request.headers["content-type"] ?? ""
        })
      );
      return;
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/json" });
      response.end();
      return;
    }
    if (url.pathname === "/sse") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "第一段" } }] })}\n\n`);
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "第二段" } }] })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      }, 150);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// ------------------------------------------------------------------ 本地 CONNECT 代理

function startProxy({ reject = false } = {}) {
  const server = createHttpServer((request, response) => {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("CONNECT only");
  });
  server.on("connect", (request, clientSocket, head) => {
    if (reject) {
      clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const [host, rawPort] = String(request.url).split(":");
    const upstream = netConnect(Number(rawPort), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head !== undefined && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const destroy = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", destroy);
    clientSocket.on("error", destroy);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// ------------------------------------------------------------------ 跑

const origin = await startOrigin();
const proxy = await startProxy();
const strictProxy = await startProxy({ reject: true });
const originUrl = `http://127.0.0.1:${origin.port}`;
const proxyUrl = `http://127.0.0.1:${proxy.port}`;

try {
  console.log("== 1. 地址解析 ==");
  const parsed = parseProxyUrl("127.0.0.1:10808");
  check("裸地址按 http 代理", parsed?.url === "http://127.0.0.1:10808", parsed?.url ?? "(none)");
  check("默认端口", parseProxyUrl("http://127.0.0.1")?.port === 80);
  const withAuth = parseProxyUrl("http://user:pass@127.0.0.1:8080");
  check("带认证的头", withAuth?.auth.startsWith("Proxy-Authorization: Basic "), withAuth?.auth ? "有" : "无");
  check("SOCKS 被识别出来", parseProxyUrl("socks5://127.0.0.1:1080")?.socks === true);
  check("非法地址返回 undefined", parseProxyUrl("::::") === undefined);

  console.log("\n== 2. 端口与可达性 ==");
  check("源站端口可连", await tcpOpen("127.0.0.1", origin.port, 500));
  check("空端口不可连", (await tcpOpen("127.0.0.1", 1, 300)) === false);
  check("代理可转发", await tunnelReachable(proxyUrl, "127.0.0.1", origin.port, 1_500));
  check("坏代理不可转发", (await tunnelReachable(`http://127.0.0.1:${strictProxy.port}`, "127.0.0.1", origin.port, 1_500)) === false);

  console.log("\n== 3. 隧道请求 ==");
  const json = await tunnelRequest(`${originUrl}/json`, { proxy: proxyUrl, timeoutMs: 5_000 });
  check("GET 状态码", json.status === 200, String(json.status));
  const text = await json.text();
  check("GET 正文", text.includes('"ok":true'), text);

  const echoed = await tunnelRequest(`${originUrl}/echo`, {
    method: "POST",
    proxy: proxyUrl,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "隧道" }),
    timeoutMs: 5_000
  });
  const echo = JSON.parse(await echoed.text());
  check("POST 方法与正文", echo.method === "POST" && echo.body === '{"hello":"隧道"}', echo.body);
  check("Content-Type 透传", echo.contentType === "application/json", echo.contentType);

  const manual = await tunnelRequest(`${originUrl}/redirect`, { proxy: proxyUrl, redirect: "manual", timeoutMs: 5_000 });
  check("manual 不跟随", manual.status === 302, String(manual.status));
  await manual.body?.cancel();
  const followed = await tunnelRequest(`${originUrl}/redirect`, { proxy: proxyUrl, redirect: "follow", timeoutMs: 5_000 });
  check("follow 跟随到目标", followed.status === 200 && (await followed.text()).includes("ok"), String(followed.status));

  console.log("\n== 4. 隧道流式 ==");
  const started = Date.now();
  const streamed = await tunnelRequest(`${originUrl}/sse`, { proxy: proxyUrl, timeoutMs: 0 });
  check("SSE 状态码", streamed.status === 200, String(streamed.status));
  const stamps = [];
  const chunks = [];
  for await (const chunk of toStreamChunks(streamed.body, "test-model")) {
    if (chunk.type === "text-delta") {
      stamps.push(Date.now() - started);
      chunks.push(chunk.text);
    }
  }
  check("两段都收到", chunks.join("") === "第一段第二段", chunks.join(""));
  check(
    "第一段先到、第二段后到",
    stamps.length === 2 && stamps[0] < 140 && stamps[1] >= 140,
    stamps.join("ms / ")
  );

  console.log("\n== 5. 出口选择与互备 ==");
  configureEgress({ proxy: proxyUrl });
  const viaProxy = await send(`${originUrl}/json`, { timeoutMs: 5_000 });
  check("显式代理生效", viaProxy.status === 200 && egressInfo().mode === "proxy", egressInfo().mode);
  await viaProxy.text();

  configureEgress({ proxy: `http://127.0.0.1:${strictProxy.port}` });
  const fallback = await send(`${originUrl}/json`, { timeoutMs: 5_000 });
  check("代理失败后回退直连", fallback.status === 200, `mode=${egressInfo().mode}`);
  await fallback.text();
  const remembered = await send(`${originUrl}/json`, { timeoutMs: 5_000 });
  check(
    "回退结论被记住（不再撞死代理）",
    remembered.status === 200 && egressInfo().mode === "direct",
    `mode=${egressInfo().mode}`
  );
  await remembered.text();

  configureEgress({});
  const auto = await send(`${originUrl}/json`, { timeoutMs: 5_000 });
  check("自动模式下本机可达则直连", auto.status === 200 && egressInfo().mode === "direct", egressInfo().mode);
  await auto.text();
} catch (error) {
  failures += 1;
  console.error("  FAIL 未捕获异常 —", error?.stack ?? String(error));
} finally {
  origin.server.close();
  proxy.server.close();
  strictProxy.server.close();
}

console.log(failures === 0 ? "\n全部通过" : `\n失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
