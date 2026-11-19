/**
 * 本机代理：探测 + CONNECT 隧道。
 *
 * 为什么需要这一层：`api.deepai.org` 在部分网络下会被 DNS 污染或直接阻断，
 * 而浏览器因为有 PAC / 系统代理一切正常。DSH 里的 Node `fetch` 只认
 * `NODE_USE_ENV_PROXY` 这类**启动期**开关，插件在运行期改 `process.env`
 * 也没用（实测），用户还得去设环境变量、重启 DSH，顺便让 DSH 自己的
 * 请求也一起绕进代理。
 *
 * 所以这里自带一条隧道：认出本机代理（显式配置 > 注册表 > PAC > 常见端口），
 * 自己发 `CONNECT` 再套 TLS，最后把响应包装成标准 `Response` 交回去。
 * 只影响本插件的上游请求，不碰进程级环境。
 */

import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 常见本机代理端口：v2rayN / Clash / sing-box / Shadowsocks 客户端的默认值。 */
const COMMON_PORTS = [10808, 10809, 7890, 7891, 7897, 1087, 1080, 2080, 8888, 8080, 20171, 20172];

const REGISTRY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const PAC_TIMEOUT_MS = 2_500;
const PAC_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

// ------------------------------------------------------------------ 地址解析

/**
 * 解析代理地址。
 *
 * 接受 `http://host:port`、`host:port`（当 http 代理）、带账号密码的形式；
 * SOCKS 因为 Node 内置能力不支持，这里明确认出来并标记，交给上层提示用户。
 *
 * @returns {{url:string, protocol:string, host:string, port:number, auth:string, socks:boolean}|undefined}
 */
export function parseProxyUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return undefined;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  const protocol = url.protocol.toLowerCase();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "") return undefined;
  const fallbackPort = protocol === "https:" ? 443 : protocol.startsWith("socks") ? 1080 : 80;
  const port = url.port !== "" ? Number.parseInt(url.port, 10) : fallbackPort;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined;
  let auth = "";
  if (url.username !== "") {
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password);
    auth = `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
  }
  return {
    url: `${protocol}//${host}:${port}`,
    protocol,
    host,
    port,
    auth,
    socks: protocol.startsWith("socks")
  };
}

/** 端口探测：只回答「这个 TCP 端口能不能连上」。 */
export function tcpOpen(host, port, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = netConnect({ host, port });
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setNoDelay(true);
  });
}

// ------------------------------------------------------------------ 候选发现

async function registrySettings() {
  if (process.platform !== "win32") return {};
  try {
    const { stdout } = await execFileAsync("reg", ["query", REGISTRY_KEY], {
      timeout: 4_000,
      windowsHide: true
    });
    const out = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*(ProxyEnable|ProxyServer|AutoConfigURL)\s+REG_\w+\s+(.*)$/i.exec(line);
      if (match !== null) out[match[1].toLowerCase()] = match[2].trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** `ProxyServer` 既可能是 `host:port`，也可能是 `http=x;p=https=y` 这种分组写法。 */
function proxyServerEntries(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return [];
  if (!text.includes("=")) return [text];
  const out = [];
  for (const part of text.split(";")) {
    const [scheme, value] = part.split("=", 2);
    if (value === undefined) continue;
    const key = scheme.trim().toLowerCase();
    // SOCKS 站内没法用（Node 内置不支持），跳过
    if (key.startsWith("socks")) continue;
    out.push(value.trim());
  }
  return out;
}

/** 从 PAC 脚本里抠出 `PROXY host:port` / `HTTPS host:port`。 */
function pacProxies(script) {
  const out = [];
  const pattern = /\b(?:PROXY|HTTPS)\s+([A-Za-z0-9_.:[\]-]+)/gi;
  let match;
  while ((match = pattern.exec(script)) !== null) out.push(match[1]);
  return out;
}

function readPac(pacUrl) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(pacUrl);
    } catch {
      resolve("");
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      resolve("");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAC_TIMEOUT_MS);
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number.parseInt(url.port, 10),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { "User-Agent": "dsh-deepai-freemodel", Accept: "*/*" },
        signal: controller.signal
      },
      (response) => {
        let text = "";
        let size = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > PAC_MAX_BYTES) {
            controller.abort();
            return;
          }
          text += chunk;
        });
        response.on("end", () => {
          clearTimeout(timer);
          resolve(response.statusCode === 200 ? text : "");
        });
      }
    );
    request.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    request.end();
  });
}

/**
 * 收集候选代理地址，按「可信度」排序：显式配置 > 系统设置 > PAC > 常见端口。
 *
 * 常见端口只保留真的在监听的，避免每次请求都去撞空端口。
 */
export async function detectProxyCandidates({ explicit = "", timeoutMs = 1_200 } = {}) {
  const candidates = [];
  const seen = new Set();
  const push = (raw) => {
    const parsed = parseProxyUrl(raw);
    if (parsed === undefined || parsed.socks) return;
    if (seen.has(parsed.url)) return;
    seen.add(parsed.url);
    candidates.push(parsed.url);
  };

  if (explicit !== "") push(explicit);

  const settings = await registrySettings();
  for (const entry of proxyServerEntries(settings.proxyserver)) push(entry);

  const pacUrl = settings.autoconfigurl ?? "";
  if (pacUrl !== "") {
    const script = await readPac(pacUrl);
    if (script !== "") for (const entry of pacProxies(script)) push(entry);
  }

  const open = await Promise.all(
    COMMON_PORTS.map(async (port) => ((await tcpOpen("127.0.0.1", port, timeoutMs)) ? port : 0))
  );
  for (const port of open) if (port !== 0) push(`127.0.0.1:${port}`);

  return candidates;
}

// ------------------------------------------------------------------ CONNECT 隧道

function abortError() {
  const error = new Error("请求已中断");
  error.name = "AbortError";
  return error;
}

function proxyError(code, message, hint) {
  const error = new Error(message);
  error.code = code;
  if (hint !== undefined) error.hint = hint;
  return error;
}

/**
 * 打通「本机代理 → 上游」：发 CONNECT，握手成功后返回可读写的隧道 socket。
 */
function openTunnel({ proxy, host, port, signal, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let buffer = "";

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onFail);
      socket.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onFail = (error) =>
      finish(
        reject,
        proxyError("EPROXY", `连不上本机代理 ${proxy.url}：${error?.message ?? String(error)}`, "检查代理客户端是否在运行。")
      );
    const onClose = () => finish(reject, proxyError("EPROXY", `本机代理 ${proxy.url} 提前关闭了连接`));
    const onAbort = () => {
      finish(reject, abortError());
      socket.destroy();
    };
    const onData = (chunk) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffer.length > 16 * 1024) finish(reject, proxyError("EPROXY", `本机代理 ${proxy.url} 返回了异常长的握手`));
        return;
      }
      const head = buffer.slice(0, end);
      const rest = buffer.slice(end + 4);
      const status = Number.parseInt(head.split("\r\n")[0]?.split(" ")[1] ?? "", 10);
      if (status === 407) {
        finish(reject, proxyError("EPROXY_AUTH", `本机代理 ${proxy.url} 要求认证`));
        socket.destroy();
        return;
      }
      if (status !== 200) {
        finish(
          reject,
          proxyError("EPROXY_REFUSED", `本机代理 ${proxy.url} 拒绝转发 ${host}:${port}（HTTP ${status || "?"}）`)
        );
        socket.destroy();
        return;
      }
      settled = true;
      cleanup();
      if (rest !== "") socket.unshift(Buffer.from(rest, "latin1"));
      resolve(socket);
    };
    const timer = setTimeout(
      () => {
        finish(reject, proxyError("EPROXY_TIMEOUT", `本机代理 ${proxy.url} 握手超时`));
        socket.destroy();
      },
      timeoutMs
    );

    if (signal !== undefined) {
      if (signal.aborted) {
        finish(reject, abortError());
        socket.destroy();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    socket.on("data", onData);
    socket.on("error", onFail);
    socket.on("close", onClose);
    socket.setNoDelay(true);
    socket.once("connect", () => {
      const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Proxy-Connection: keep-alive",
        ...(proxy.auth !== "" ? [proxy.auth] : [])
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
  });
}

/** TLS 会话缓存：复用到同一个上游时能省掉一次完整握手（实测 2.5s → 1s 级）。 */
const tlsSessions = new Map();

function wrapTls(socket, host, sessionKey, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const session = tlsSessions.get(sessionKey);
    const secure = tlsConnect({
      socket,
      servername: host,
      ALPNProtocols: ["http/1.1"],
      ...(session === undefined ? {} : { session })
    });
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      secure.removeListener("secureConnect", onSecure);
      secure.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onSecure = () => {
      try {
        const next = secure.getSession();
        if (next !== undefined && next.length > 0) tlsSessions.set(sessionKey, next);
      } catch {
        /* 拿不到就算了，下次重新握手 */
      }
      finish(resolve, secure);
    };
    const onError = (error) => finish(reject, error);
    const onAbort = () => {
      finish(reject, abortError());
      secure.destroy();
    };
    const timer = setTimeout(
      () => {
        finish(reject, proxyError("EPROXY_TIMEOUT", `隧道 TLS 握手超时（${host}）`));
        secure.destroy();
      },
      timeoutMs
    );
    secure.once("secureConnect", onSecure);
    secure.once("error", onError);
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 探测「这个代理愿不愿意把包送到 host:port」：只做 CONNECT，不握手 TLS。
 *
 * 不在这里多做一次 TLS 是刻意的：到上游一次握手要 ~2.5 秒，探测和真正的请求
 * 各付一次就太贵了。TLS 能不能过，交给真正的请求去发现（失败会自动回退）。
 */
export async function tunnelReachable(proxyUrl, host, port, timeoutMs = 4_000) {
  const proxy = parseProxyUrl(proxyUrl);
  if (proxy === undefined || proxy.socks) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let socket;
  try {
    socket = await openTunnel({ proxy, host, port, signal: controller.signal, timeoutMs });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    try {
      socket?.destroy();
    } catch {
      /* 已经关了 */
    }
  }
}

// ------------------------------------------------------------------ 请求

function targetOf(url) {
  const parsed = url instanceof URL ? url : new URL(url);
  const secure = parsed.protocol !== "http:";
  return {
    url: parsed,
    secure,
    host: parsed.hostname,
    port: parsed.port !== "" ? Number.parseInt(parsed.port, 10) : secure ? 443 : 80,
    path: `${parsed.pathname}${parsed.search}`
  };
}

function buildHeaders(raw, target, body, method) {
  const headers = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null) continue;
    headers[key] = String(value);
  }
  headers.Host = target.url.host;
  // 隧道本身很贵（CONNECT + TLS 要两三个 RTT），所以按 HTTP/1.1 长连接复用；
  // 上游说 close 时下面会按响应头把它拆掉。
  headers.Connection = "keep-alive";
  if (body !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(body));
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }
  if (method === "GET" || method === "HEAD") delete headers["Content-Length"];
  return headers;
}

// ------------------------------------------------------------------ 空闲隧道池

/**
 * 按「代理 + 目标」复用已建立的隧道连接。
 *
 * 实测每次重新 CONNECT + TLS 要 ~3 秒，而复用只要 ~0.6 秒；对话一多这层开销
 * 会直接体现成首字延迟。只在响应体读完（`end`）之后才归还；中断、读不完整或
 * 上游说 close 的一律销毁，绝不把半截连接放回去。
 */
const POOL_TTL_MS = 25_000;
const POOL_MAX_IDLE = 2;
const STALE_CHECK_MS = 8_000;
const idleSockets = new Map();

function poolKey(proxy, target) {
  return `${proxy.url}|${target.host}:${target.port}`;
}

function takeIdle(key) {
  const list = idleSockets.get(key);
  while (list !== undefined && list.length > 0) {
    const entry = list.pop();
    if (!entry.socket.destroyed && Date.now() <= entry.expiresAt) return entry.socket;
    entry.socket.destroy();
  }
  return undefined;
}

function giveBack(key, socket) {
  if (socket.destroyed || !socket.writable) {
    socket.destroy();
    return;
  }
  const list = idleSockets.get(key) ?? [];
  if (list.length >= POOL_MAX_IDLE) {
    socket.destroy();
    return;
  }
  const entry = { socket, expiresAt: Date.now() + POOL_TTL_MS };
  const drop = () => {
    const current = idleSockets.get(key);
    const index = current === undefined ? -1 : current.indexOf(entry);
    if (index >= 0) current.splice(index, 1);
  };
  socket.once("close", drop);
  socket.once("error", drop);
  list.push(entry);
  idleSockets.set(key, list);
}

// 池子里的连接到期就清掉：代理端也可能主动断，留着只会让下次请求白等
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, list] of idleSockets) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (now > list[i].expiresAt || list[i].socket.destroyed) {
        if (!list[i].socket.destroyed) list[i].socket.destroy();
        list.splice(i, 1);
      }
    }
    if (list.length === 0) idleSockets.delete(key);
  }
}, 10_000);
sweeper.unref?.();

async function openTlsTunnel(proxy, target, signal, budget) {
  const tunnel = await openTunnel({ proxy, host: target.host, port: target.port, signal, timeoutMs: budget });
  if (!target.secure) return tunnel;
  try {
    return await wrapTls(tunnel, target.host, poolKey(proxy, target), signal, budget);
  } catch (error) {
    tunnel.destroy();
    throw error;
  }
}

/** 在已建立的连接上发一次请求，拿到响应头即返回。 */
function exchangeOver(socket, target, { method, headers, payload, signal, timeoutMs, headerTimeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let request;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        request?.destroy();
      } catch {
        /* 已经结束 */
      }
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(abortError());
    try {
      request = httpRequest(
        { method, path: target.path, headers, createConnection: () => socket },
        (incoming) => {
          if (settled) {
            incoming.destroy();
            return;
          }
          settled = true;
          cleanup();
          // 响应头到了，复用前的「这条连接可能已经被代理端回收」保护可以撤了
          try {
            request.setTimeout(0);
          } catch {
            /* 已经结束 */
          }
          resolve(incoming);
        }
      );
    } catch (error) {
      fail(error);
      return;
    }
    if (headerTimeoutMs > 0) {
      request.setTimeout(headerTimeoutMs, () => {
        fail(proxyError("EPROXY_STALE", `复用的连接没有响应（${Math.round(headerTimeoutMs / 1000)} 秒）`));
      });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(
          proxyError("EPROXY_TIMEOUT", `经代理请求超时（${Math.round(timeoutMs / 1000)} 秒）`, "代理不稳定或上游无响应。")
        );
      }, timeoutMs);
    }
    request.on("error", (error) => fail(error));
    if (signal !== undefined) {
      if (signal.aborted) {
        fail(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    request.end(payload);
  });
}

/** 把 IncomingMessage 包成标准 Response，并决定这条连接归还还是销毁。 */
function wrapResponse(incoming, socket, key, method, signal) {
  const status = incoming.statusCode ?? 0;
  if (status < 200) {
    socket.destroy();
    throw proxyError("EPROXY_STATUS", `上游返回了无法处理的状态码 ${status || "?"}`);
  }
  const headerPairs = [];
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    headerPairs.push([incoming.rawHeaders[i], incoming.rawHeaders[i + 1]]);
  }
  const upstreamClosed = String(incoming.headers.connection ?? "").toLowerCase() === "close";
  const reusable = !upstreamClosed && incoming.destroyed === false;
  const release = () => {
    if (reusable) giveBack(key, socket);
    else socket.destroy();
  };

  const noBody = method === "HEAD" || status === 204 || status === 304;
  if (noBody) {
    incoming.resume();
    incoming.once("end", release);
    return new Response(null, { status, headers: headerPairs });
  }

  const onAbort = () => {
    incoming.destroy();
    socket.destroy();
  };
  if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });

  incoming.once("end", () => {
    signal?.removeEventListener("abort", onAbort);
    release();
  });
  incoming.once("error", () => {
    signal?.removeEventListener("abort", onAbort);
    socket.destroy();
  });
  incoming.once("close", () => {
    signal?.removeEventListener("abort", onAbort);
    // 没读完就被关掉（调用方取消或隧道断了）：绝不能归还
    if (incoming.complete !== true) socket.destroy();
  });
  return new Response(Readable.toWeb(incoming), { status, headers: headerPairs });
}

async function sendOnce(rawUrl, { method, headers, body, signal, timeoutMs, proxy }) {
  const target = targetOf(rawUrl);
  const budget = Math.min(timeoutMs > 0 ? timeoutMs : 10_000, 10_000);
  const payload = body === undefined ? undefined : typeof body === "string" ? body : Buffer.from(body);
  const finalHeaders = buildHeaders(headers, target, payload, method);
  const key = poolKey(proxy, target);

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let socket = attempt === 0 ? takeIdle(key) : undefined;
    const reused = socket !== undefined;
    if (socket === undefined) socket = await openTlsTunnel(proxy, target, signal, budget);
    try {
      const incoming = await exchangeOver(socket, target, {
        method,
        headers: finalHeaders,
        payload,
        signal,
        timeoutMs,
        headerTimeoutMs: reused ? STALE_CHECK_MS : 0
      });
      return wrapResponse(incoming, socket, key, method, signal);
    } catch (error) {
      lastError = error;
      socket.destroy();
      // 复用的连接可能已经被代理端悄悄回收：换一条新连接再试一次
      if (!reused || error?.name === "AbortError") throw error;
    }
  }
  throw lastError;
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 经本机代理发一次请求，返回标准 `Response`。
 *
 * 与 `fetch` 的行为对齐：默认跟随重定向（POST 遇到 301/302/303 退化成 GET），
 * `redirect: "manual"` 时把 3xx 原样交回去——上游对失效 Key 会 302 到登录页，
 * 跟随会把鉴权失败伪装成 200。
 */
export async function tunnelRequest(url, options = {}) {
  const {
    method = "GET",
    headers,
    body,
    signal,
    timeoutMs = 60_000,
    proxy: proxyUrl,
    redirect = "follow"
  } = options;
  const proxy = parseProxyUrl(proxyUrl);
  if (proxy === undefined) throw proxyError("EPROXY", `代理地址不合法：${proxyUrl}`);
  if (proxy.socks) {
    throw proxyError(
      "EPROXY_SOCKS",
      `暂不支持 SOCKS 代理 ${proxy.url}`,
      "请在代理客户端里打开 HTTP 入站端口（v2rayN 默认 10809，或直接把 10808 当 HTTP 代理用）。"
    );
  }

  let currentUrl = typeof url === "string" ? new URL(url) : new URL(url.toString());
  let currentMethod = method.toUpperCase();
  let currentBody = body;

  for (let hop = 0; hop <= DEFAULT_MAX_REDIRECTS; hop += 1) {
    const response = await sendOnce(currentUrl, {
      method: currentMethod,
      headers,
      body: currentBody,
      signal,
      timeoutMs,
      proxy
    });
    if (redirect === "manual" || !isRedirectStatus(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null || location === "") return response;
    // 先放掉这一跳的响应体，隧道才不会被晾着
    try {
      await response.body?.cancel();
    } catch {
      /* 已经结束 */
    }
    let next;
    try {
      next = new URL(location, currentUrl);
    } catch {
      return response;
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
      currentMethod = "GET";
      currentBody = undefined;
    }
    currentUrl = next;
  }
  throw proxyError("EPROXY_REDIRECT", "重定向次数过多");
}
