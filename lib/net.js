/**
 * 网络层：出口选择 + 统一超时、重试、错误归一化。
 *
 * 出口按「谁说得更明确」排序：
 * 1. 插件配置 / `DEEPAI_PROXY` 显式指定的代理 —— 一律走它；
 * 2. `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` —— 交给 Node 内置 fetch 自己走；
 * 3. 自动判断 —— 先探一次到上游的 TCP 通不通。通就直接走；不通就去认本机代理
 *    （注册表 / PAC / 常见端口），用自带 CONNECT 隧道发请求。
 *
 * 第 3 步是为「浏览器能打开、插件进程连不上」这种最常见的失败准备的：
 * 浏览器有 PAC，Node 没有，用户看到的报错却是「上游拒绝了这个 code」。
 *
 * 选中的出口会记住；某条路失败一次就换另一条再试，换成功后一直用新的。
 */

import { UpstreamError, classify, errorCodeOf, errorMessageOf, retryAfterSeconds } from "./protocol.js";
import { detectProxyCandidates, parseProxyUrl, tcpOpen, tunnelReachable, tunnelRequest } from "./proxy.js";

const DIRECT_PROBE_MS = 1_500;
const PROXY_PROBE_MS = 3_000;

export class NetworkError extends Error {
  constructor(message, { cause, hint, code } = {}) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
    this.hint = hint;
    if (code !== undefined) this.code = code;
  }
}

/** 当前进程是否处于「有代理」的环境，给诊断面板用。 */
export function proxyInfo(env = process.env) {
  const raw = (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "").trim();
  const viaEnvProxy = (env.NODE_USE_ENV_PROXY ?? "") === "1";
  // Node 内置 fetch 只有开了 NODE_USE_ENV_PROXY 才会读代理变量；
  // 「填了 HTTPS_PROXY 但没开开关」必须单独告诉用户，否则会误判成已生效。
  return {
    enabled: viaEnvProxy,
    configured: raw !== "",
    viaEnvProxy,
    url: raw
  };
}

// ------------------------------------------------------------------ 出口

const egress = {
  configured: "",
  mode: "",
  proxy: "",
  detail: "",
  log: undefined
};

const plans = new Map();

/** 配置出口。`proxy` 支持 `http://127.0.0.1:10808` 或裸 `127.0.0.1:10808`。 */
export function configureEgress({ proxy = "", log } = {}) {
  const parsed = parseProxyUrl(proxy);
  egress.configured = parsed === undefined ? "" : parsed.url;
  egress.log = log;
  egress.mode = "";
  egress.proxy = "";
  egress.detail = parsed === undefined && proxy !== "" ? `代理地址无法识别：${proxy}` : "";
  plans.clear();
}

/** 出口状态快照，设置页与日志共用。 */
export function egressInfo() {
  return {
    mode: egress.mode,
    proxy: egress.proxy,
    configured: egress.configured,
    detail: egress.detail,
    env: proxyInfo()
  };
}

function remember(plan) {
  const changed = egress.mode !== plan.mode || egress.proxy !== (plan.proxy ?? "");
  egress.mode = plan.mode;
  egress.proxy = plan.proxy ?? "";
  egress.detail = plan.reason ?? "";
  if (changed) {
    const label =
      plan.mode === "proxy"
        ? `经本机代理 ${plan.proxy}`
        : plan.mode === "env"
          ? "经环境变量代理"
          : "直连上游";
    egress.log?.info?.(`dsh-deepai-freemodel: 出口 ${label}${plan.reason !== undefined ? `（${plan.reason}）` : ""}`);
  }
}

function portOf(target) {
  if (target.port !== "") return Number.parseInt(target.port, 10);
  return target.protocol === "http:" ? 80 : 443;
}

async function decide(url) {
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = portOf(target);

  if (egress.configured !== "") {
    const plan = { mode: "proxy", proxy: egress.configured, host, port, reason: "已显式配置代理" };
    remember(plan);
    return plan;
  }

  const env = proxyInfo();
  if (env.enabled) {
    const plan = { mode: "env", host, port, reason: `环境变量代理 ${env.url !== "" ? env.url : ""}`.trim() };
    remember(plan);
    return plan;
  }

  const explicit = (process.env.DEEPAI_PROXY ?? "").trim();
  // 探测和候选收集互不依赖，一起跑，别让用户等两次网络往返
  const [directOk, candidates] = await Promise.all([
    tcpOpen(host, port, DIRECT_PROBE_MS),
    detectProxyCandidates({ explicit })
  ]);

  if (directOk) {
    const plan = { mode: "direct", host, port, candidates, reason: "上游可直接连接" };
    remember(plan);
    return plan;
  }

  for (const candidate of candidates) {
    if (await tunnelReachable(candidate, host, port, PROXY_PROBE_MS)) {
      const plan = { mode: "proxy", proxy: candidate, host, port, candidates, reason: "直连不通，自动使用本机代理" };
      remember(plan);
      return plan;
    }
  }

  const plan = {
    mode: "direct",
    host,
    port,
    candidates,
    reason: candidates.length > 0 ? "直连不通，本机代理也不可用" : "直连不通，也没有发现本机代理"
  };
  remember(plan);
  return plan;
}

function planKey(url) {
  const target = new URL(url);
  return `${target.hostname}:${portOf(target)}`;
}

function planFor(url) {
  const key = planKey(url);
  let promise = plans.get(key);
  if (promise === undefined) {
    promise = decide(url).catch((error) => {
      plans.delete(key);
      throw error;
    });
    plans.set(key, promise);
  }
  return promise;
}

/** 预热出口判断：启动时后台跑一次，免得用户点「登录」才等探测。 */
export async function warmEgress(url) {
  try {
    await planFor(url);
  } catch {
    /* 预热失败不影响后面重试 */
  }
}

// ------------------------------------------------------------------ 失败描述

function describeTransportError(error) {
  const cause = error?.cause;
  const code = cause?.code ?? error?.code ?? "";
  const detail = cause?.message ?? error?.message ?? String(error);
  if (typeof code === "string" && code.startsWith("EPROXY")) {
    return {
      message: detail,
      hint: error?.hint ?? "本机代理拒绝转发。检查代理客户端的规则是否放行 api.deepai.org。"
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      message: `无法解析上游域名（${code}）`,
      hint: "本机 DNS 可能被污染。填一个本机代理地址（设置或 DEEPAI_PROXY），插件会自己走隧道。"
    };
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return {
      message: `连不上上游（${code}）`,
      hint: "本机直连被阻断。插件会尝试本机代理；也可以在设置里填代理地址，或设置 DEEPAI_PROXY。"
    };
  }
  if (String(detail).includes("certificate")) {
    return { message: "TLS 证书校验失败", hint: "公司网络或中间人代理改写了证书，请换网络或信任该证书。" };
  }
  return { message: `网络请求失败：${detail}`, hint: "检查网络或代理设置后重试。" };
}

function mergeSignals(signal, timeoutMs) {
  const signals = [];
  if (signal !== undefined) signals.push(signal);
  if (timeoutMs !== undefined && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function normalizeTransportError(error, signal, timeoutMs) {
  if (error instanceof NetworkError) return error;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    if (signal?.aborted === true) return new NetworkError("请求已中断", { cause: error });
    return new NetworkError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`, {
      cause: error,
      hint: "上游无响应。可能是代理不稳定或该模型排队，稍后重试。"
    });
  }
  const described = describeTransportError(error);
  return new NetworkError(described.message, { cause: error, hint: described.hint, code: error?.code });
}

/** 只有「连接层就失败」才值得换一条出口再试；中断、超时、上游语义错误都不换。 */
function isTransportFailure(error) {
  if (error instanceof UpstreamError || error instanceof NetworkError) return false;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return false;
  if (typeof error?.code === "string" && error.code.startsWith("UPSTREAM")) return false;
  return true;
}

async function alternatePlan(plan, url, error) {
  if (!isTransportFailure(error)) return undefined;
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = portOf(target);

  if (plan.mode === "proxy") {
    return { mode: "direct", host, port, candidates: plan.candidates, reason: "代理请求失败，回退直连" };
  }
  if (plan.mode === "direct") {
    for (const candidate of plan.candidates ?? []) {
      const parsed = parseProxyUrl(candidate);
      if (parsed === undefined || parsed.socks) continue;
      if (await tcpOpen(parsed.host, parsed.port, 1_200)) {
        return { mode: "proxy", proxy: candidate, host, port, candidates: plan.candidates, reason: "直连失败，改用本机代理" };
      }
    }
  }
  return undefined;
}

function execute(plan, url, options) {
  if (plan.mode === "proxy") return tunnelRequest(url, { ...options, proxy: plan.proxy });
  return fetch(url, options);
}

// ------------------------------------------------------------------ 请求

/**
 * 发一次请求，返回未解析的响应。
 *
 * HTTP 状态不抛错（车道探测需要看 426），只有传输层失败才抛 NetworkError。
 */
export async function send(url, { method = "GET", headers, body, signal, timeoutMs = 60_000, redirect = "follow" } = {}) {
  const finalSignal = mergeSignals(signal, timeoutMs);
  const options = { method, headers, body, signal: finalSignal, timeoutMs, redirect };
  let plan;
  try {
    plan = await planFor(url);
  } catch (error) {
    throw normalizeTransportError(error, signal, timeoutMs);
  }
  try {
    return await execute(plan, url, options);
  } catch (error) {
    const alternate = await alternatePlan(plan, url, error);
    if (alternate === undefined) throw normalizeTransportError(error, signal, timeoutMs);
    try {
      const response = await execute(alternate, url, options);
      // 换成功就把结论记在这个主机上，后续请求别再重复踩一遍失败的路
      remember(alternate);
      plans.set(planKey(url), Promise.resolve(alternate));
      return response;
    } catch (second) {
      throw normalizeTransportError(second, signal, timeoutMs);
    }
  }
}

async function readBody(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function toUpstreamError(response, text, operation) {
  const code = errorCodeOf(text);
  const detail = errorMessageOf(text);
  const error = new UpstreamError({
    status: response.status,
    code,
    kind: classify(response.status, code, text),
    body: text,
    message: detail !== "" ? detail : `${operation}失败（HTTP ${response.status}）`
  });
  // 只有上游真的给了 Retry-After 才记，否则别伪造一个「等 3 秒」
  const retryHeader = response.headers.get("retry-after");
  if (retryHeader !== null && String(retryHeader).trim() !== "") {
    error.retryAfter = retryAfterSeconds(retryHeader);
  }
  return error;
}

/** JSON 请求：非 2xx 直接抛结构化错误。 */
export async function sendJson(url, options = {}) {
  const { operation = "请求", ...rest } = options;
  const response = await send(url, rest);
  const text = await readBody(response);
  if (!response.ok) throw toUpstreamError(response, text, operation);
  if (text.trim() === "") return { status: response.status, headers: response.headers, data: undefined };
  try {
    return { status: response.status, headers: response.headers, data: JSON.parse(text) };
  } catch {
    throw new UpstreamError({
      status: response.status,
      kind: "other",
      body: text,
      message: `${operation}返回了非 JSON 响应：${text.trim().slice(0, 120)}`
    });
  }
}

/** 纯文本请求：保留状态码，交给调用方判定。 */
export async function sendText(url, options = {}) {
  const response = await send(url, options);
  const text = await readBody(response);
  return { status: response.status, ok: response.ok, headers: response.headers, text };
}

/** 流式请求：非 2xx 也读成文本，方便报错。 */
export async function sendStream(url, options = {}) {
  const { operation = "请求", ...rest } = options;
  const response = await send(url, rest);
  if (!response.ok) {
    const text = await readBody(response);
    throw toUpstreamError(response, text, operation);
  }
  if (response.body === null) {
    throw new UpstreamError({ status: response.status, kind: "other", message: `${operation}没有返回内容` });
  }
  return { status: response.status, headers: response.headers, body: response.body };
}

/** 轻量重试：仅对可重试错误生效，指数退避 + 抖动。 */
export async function withRetry(fn, { attempts = 3, baseMs = 400, maxMs = 8_000, onRetry, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted === true) throw lastError ?? new NetworkError("请求已中断");
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof UpstreamError ? error.retryable : error instanceof NetworkError;
      if (!retryable || attempt === attempts - 1) throw error;
      const suggested = error instanceof UpstreamError && error.retryAfter !== undefined ? error.retryAfter * 1000 : 0;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const delay = Math.min(maxMs, Math.max(suggested, backoff) + Math.random() * 200);
      onRetry?.(error, delay, attempt + 1);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
  throw lastError;
}
