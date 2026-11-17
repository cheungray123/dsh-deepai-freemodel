/**
 * 网络层：统一的超时、重试、错误归一化。
 *
 * 只用全局 fetch（Electron 主进程里的 undici），靠 Node 24 的
 * `NODE_USE_ENV_PROXY` 走系统代理；这里不自己实现代理隧道，
 * 但会把「请求根本没发出去」翻译成用户能看懂的话。
 */

import { UpstreamError, classify, errorCodeOf, errorMessageOf, retryAfterSeconds } from "./protocol.js";

export class NetworkError extends Error {
  constructor(message, { cause, hint } = {}) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
    this.hint = hint;
  }
}

/** 当前进程是否处于「有代理」的环境，给诊断面板用。 */
export function proxyInfo(env = process.env) {
  const raw = (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "").trim();
  const enabled = (env.NODE_USE_ENV_PROXY ?? "") === "1" || raw !== "";
  return {
    enabled,
    viaEnvProxy: (env.NODE_USE_ENV_PROXY ?? "") === "1",
    url: raw
  };
}

function describeTransportError(error) {
  const cause = error?.cause;
  const code = cause?.code ?? error?.code ?? "";
  const detail = cause?.message ?? error?.message ?? String(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      message: `无法解析上游域名（${code}）`,
      hint: "本机 DNS 可能被污染。设置 HTTPS_PROXY 并开启 NODE_USE_ENV_PROXY=1 走代理后再试。"
    };
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return {
      message: `连不上上游（${code}）`,
      hint: "检查代理是否在运行、端口是否正确；本机直连 api.deepai.org 会被拒。"
    };
  }
  if (String(detail).includes("certificate")) {
    return { message: "TLS 证书校验失败", hint: "公司网络或中间人代理改写了证书，请换网络或信任该证书。" };
  }
  return { message: `网络请求失败：${detail}`, hint: "设置 HTTPS_PROXY + NODE_USE_ENV_PROXY=1 后再试。" };
}

function mergeSignals(signal, timeoutMs) {
  const signals = [];
  if (signal !== undefined) signals.push(signal);
  if (timeoutMs !== undefined && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * 发一次请求，返回未解析的响应。
 *
 * HTTP 状态不抛错（车道探测需要看 426），只有传输层失败才抛 NetworkError。
 */
export async function send(url, { method = "GET", headers, body, signal, timeoutMs = 60_000, redirect = "follow" } = {}) {
  const finalSignal = mergeSignals(signal, timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers,
      body,
      signal: finalSignal,
      redirect
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      if (signal?.aborted === true) throw new NetworkError("请求已中断", { cause: error });
      throw new NetworkError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`, {
        cause: error,
        hint: "上游无响应。可能是代理不稳定或该模型排队，稍后重试。"
      });
    }
    const described = describeTransportError(error);
    throw new NetworkError(described.message, { cause: error, hint: described.hint });
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
