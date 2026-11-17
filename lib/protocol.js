/**
 * 上游协议层：常量、请求头、请求体构造、SSE 解析、错误判定。
 *
 * 这一层只做「把 DSH 的调用翻译成 DeepAI Code 桌面端的报文」，
 * 不碰网络、不碰状态，方便单独测试。
 */

// ---------------------------------------------------------------- 常量

export const ORIGIN = "https://api.deepai.org";
export const MODEL_BASE = "/deepai_code";

export const PATH_MODELS = "/models";
export const PATH_CHAT = "/chat/completions";
export const PATH_THEOS = "/theos";
export const PATH_SIGN_IN = "/desktop_auth/";
export const PATH_EXCHANGE = "/desktop_auth/exchange/";

/** 车道探测顺序。上游抬车道时会对旧值一律回 426。 */
export const LANE_CANDIDATES = Object.freeze([
  "7", "8", "9", "10", "11", "12", "13", "6", "5", "4", "3", "2"
]);

/** 兜底车道，仅在完全没有历史记录且候选全失败时使用。 */
export const LANE_FALLBACK = "7";

/** 桌面端版本号，随 Beacon 头发出。 */
export const APP_VERSION = "0.3.20";

export const HEADER_KEY = "Api-Key";
export const HEADER_LANE = "X-DeepAI-Code-Theos";
export const HEADER_MACHINE = "X-DeepAI-Code-Machine";
export const HEADER_INSTANCE = "X-DeepAI-Code-Instance";
export const HEADER_CHECK_IN = "X-DeepAI-Code-Check-In";
export const HEADER_BEACON = "X-DeepAI-Code-Beacon";
export const HEADER_AFFINITY = "X-Session-Affinity";

/** 桌面端固定指纹头。多带 Chrome 特征头反而会被判定为非客户端。 */
export const DESKTOP_HEADERS = Object.freeze({
  "User-Agent": "node",
  Accept: "*/*",
  "Accept-Language": "*",
  "Sec-Fetch-Mode": "cors"
});

export const CODE_SESSION_BUSY = "session_busy";
export const CODE_LANE_UNSUPPORTED = "lane_version_unsupported";
export const CODE_SOCIAL_LOGIN = "social_login_required";
export const CODE_MACHINE_REQUIRED = "machine_required";
export const CODE_EMAIL_UNVERIFIED = "email_unverified";
export const CODE_AUTH_REQUIRED = "auth_required";
export const CODE_INVALID_API_KEY = "invalid_api_key";
export const CODE_CHECK_IN_REFUSED = "check_in_refused";
export const CODE_NETWORK_BOUND = "network_bound";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Answer the user's request directly.";

/** 桌面端允许出现的请求体字段。命中形状兜底时只保留这些。 */
export const DESKTOP_CHAT_KEYS = new Set([
  "model", "messages", "tools", "tool_choice", "parallel_tool_calls",
  "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop",
  "stream", "stream_options", "store", "seed", "service_tier",
  "reasoning_effort", "prompt_cache_key"
]);

/** 规范化上游地址：允许自建反代，协议必须是 http/https。 */
export function normalizeOrigin(raw, fallback = ORIGIN) {
  const value = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  if (value === "") return fallback;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.host !== "") return value;
  } catch {
    /* 落到 fallback */
  }
  return fallback;
}

export function apiUrl(path, origin = ORIGIN) {
  return `${normalizeOrigin(origin)}${MODEL_BASE}${path}`;
}

/** 组一次请求的公共头。machine / apiKey 为空时不带对应头。 */
export function buildHeaders({ lane, instance, machine, apiKey }) {
  const headers = { ...DESKTOP_HEADERS, [HEADER_LANE]: String(lane) };
  if (instance) headers[HEADER_INSTANCE] = instance;
  if (machine) headers[HEADER_MACHINE] = machine;
  if (apiKey) headers[HEADER_KEY] = apiKey;
  return headers;
}

// ---------------------------------------------------------------- 错误判定

export function errorCodeOf(body) {
  try {
    const parsed = JSON.parse(body);
    const code = parsed?.error?.code ?? parsed?.code;
    return typeof code === "string" ? code : "";
  } catch {
    return "";
  }
}

export function errorMessageOf(body) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    /* 非 JSON，退回截断原文 */
  }
  const text = typeof body === "string" ? body.trim() : "";
  return text.slice(0, 200);
}

export function retryAfterSeconds(header, fallback = 3) {
  if (header === null || header === undefined || String(header).trim() === "") return fallback;
  const parsed = Number.parseInt(String(header).trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(30, Math.max(1, parsed));
}

/**
 * 上游错误分类。
 *
 * `kind` 决定 DSH 侧的处理方式：
 * - `auth`      登录态失效，必须重新授权
 * - `policy`    账号策略拦截，换号/重试都无解
 * - `lane`      车道版本不被接受
 * - `busy`      上游繁忙，带 Retry-After
 * - `network`   链路层失败，可能是代理/网络
 * - `body`      请求体形状被拒，可换形状重试一次
 * - `other`     其余
 */
export class UpstreamError extends Error {
  constructor({ status = 0, code = "", message = "", body = "", retryAfter, kind = "other", cause }) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.kind = kind;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (cause !== undefined) this.cause = cause;
  }

  get retryable() {
    // 上游后端偶发拒收：同一份报文重发往往就落到健康节点，值得有界重试
    if (this.kind === "provider") return true;
    if (["auth", "policy", "lane", "body"].includes(this.kind)) return false;
    if (this.status === 400 || this.status === 404 || this.status === 422) return false;
    return this.kind === "busy" || this.kind === "network" || this.status === 429 || this.status >= 500;
  }
}

export function classify(status, code, body) {
  if (status === 426 || code === CODE_LANE_UNSUPPORTED) return "lane";
  if (code === CODE_SOCIAL_LOGIN || code === CODE_MACHINE_REQUIRED ||
      code === CODE_EMAIL_UNVERIFIED || code === CODE_NETWORK_BOUND ||
      code === CODE_CHECK_IN_REFUSED) return "policy";
  if (status === 401 || code === CODE_AUTH_REQUIRED || code === CODE_INVALID_API_KEY) return "auth";
  if (status === 409 && code === CODE_SESSION_BUSY) return "busy";
  if (status === 429) return "busy";
  if (status === 400 && isBodyRejected(body)) return "body";
  if (status === 400 && isProviderRejected(body)) return "provider";
  return "other";
}

/** 请求体形状被拒。新车道与旧车道的文案不一样，两种都认。 */
export function isBodyRejected(body) {
  const text = typeof body === "string" ? body.toLowerCase() : "";
  return text.includes("not one deepai code sends") || text.includes("cannot be accepted");
}

/**
 * 上游「模型提供方拒收」。
 *
 * 与请求体形状无关：是模型那一侧不接受这次请求（上下文过长、附件过大、
 * 或内容命中安全策略）。换形状重发没用，只能换模型或缩短对话。
 */
export function isProviderRejected(body) {
  const text = typeof body === "string" ? body.toLowerCase() : "";
  return text.includes("model provider rejected") || text.includes("reducing the conversation");
}

// ---------------------------------------------------------------- 消息转换

function blocksOf(content) {
  return Array.isArray(content) ? content.filter((b) => b !== null && typeof b === "object") : [];
}

function flattenText(message) {
  return blocksOf(message.content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("");
}

function parseArguments(raw) {
  if (raw !== null && typeof raw === "object") return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      /* 非法 JSON，按空对象处理 */
    }
  }
  return {};
}

function messageToolCallId(message) {
  if (typeof message.toolCallId === "string" && message.toolCallId !== "") return message.toolCallId;
  if (typeof message.tool_call_id === "string" && message.tool_call_id !== "") return message.tool_call_id;
  const source = message.source;
  if (source?.kind === "tool" && typeof source.callId === "string" && source.callId !== "") {
    return source.callId;
  }
  return undefined;
}

/** DSH 消息数组 → OpenAI 风格消息数组。 */
export function toOpenAIMessages(messages) {
  const out = [];
  for (const message of messages ?? []) {
    if (message === null || typeof message !== "object") continue;

    if (message.role === "assistant") {
      const texts = [];
      const toolCalls = [];
      let reasoning = "";
      for (const block of blocksOf(message.content)) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "reasoning" && typeof block.text === "string") {
          reasoning += block.text;
        } else if (block.type === "tool-call") {
          const id = typeof block.id === "string" ? block.id : "";
          const name = typeof block.name === "string" ? block.name : "";
          if (id === "" || name === "") continue;
          toolCalls.push({
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(parseArguments(block.arguments)) }
          });
        }
      }
      for (const call of message.tool_calls ?? []) {
        const id = typeof call?.id === "string" ? call.id : "";
        const name = typeof call?.function?.name === "string" ? call.function.name : "";
        if (id === "" || name === "") continue;
        toolCalls.push({
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(parseArguments(call.function?.arguments)) }
        });
      }
      const text = texts.join("");
      const assistant = {
        role: "assistant",
        content: text !== "" ? text : toolCalls.length > 0 ? null : ""
      };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      if (reasoning !== "") assistant.reasoning_content = reasoning;
      out.push(assistant);
      continue;
    }

    const toolCallId = messageToolCallId(message);
    if (toolCallId !== undefined) {
      const text = flattenText(message);
      out.push({
        role: "tool",
        tool_call_id: toolCallId,
        // 上游不接受空 content，补个占位
        content: text !== "" ? text : "(no output)",
        ...(message.isError === true ? { is_error: true } : {})
      });
      continue;
    }

    const inlineResults = blocksOf(message.content).filter((b) => b.type === "tool-result");
    if (inlineResults.length > 0) {
      for (const result of inlineResults) {
        const id = typeof result.toolCallId === "string" ? result.toolCallId : "";
        if (id === "") continue;
        const text = blocksOf(result.content)
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => String(b.text))
          .join("");
        out.push({
          role: "tool",
          tool_call_id: id,
          content: text !== "" ? text : "(no output)",
          ...(result.isError === true ? { is_error: true } : {})
        });
      }
      continue;
    }

    const parts = [];
    for (const block of blocksOf(message.content)) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
        parts.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
      }
    }
    const role = message.role === "system" ? "system" : message.role === "developer" ? "developer" : "user";
    if (parts.length === 0) out.push({ role, content: "" });
    else if (parts.length === 1 && parts[0].type === "text") out.push({ role, content: parts[0].text });
    else out.push({ role, content: parts });
  }
  return out;
}

export function hasSystemMessage(messages) {
  return messages.some((m) => m.role === "system" || m.role === "developer");
}

/**
 * 构造 chat 请求体。
 *
 * 上游对「没有 system 消息」的请求会直接 400，这里始终补齐，
 * 不依赖失败后重试。
 */
export function buildChatBody(options, model, systemPrompt) {
  const messages = toOpenAIMessages(options.messages);
  const prompt = systemPrompt !== undefined && systemPrompt !== "" ? systemPrompt : options.system;
  if (!hasSystemMessage(messages)) {
    messages.unshift({
      role: "system",
      content: prompt !== undefined && prompt !== "" ? prompt : DEFAULT_SYSTEM_PROMPT
    });
  }
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    store: false
  };
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} }
      }
    }));
    body.parallel_tool_calls = true;
  }
  if (options.maxTokens !== undefined) body.max_completion_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  const effort = options.reasoningEffort ?? options.reasoning;
  if (effort !== undefined && effort !== "") body.reasoning_effort = effort === "off" ? "none" : effort;
  return body;
}

/** 失败后按桌面端白名单重排一次请求体。 */
export function strictChatBody(body, systemPrompt) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return undefined;
  const strict = {};
  for (const [key, value] of Object.entries(body)) {
    if (DESKTOP_CHAT_KEYS.has(key)) strict[key] = value;
  }
  if (!hasSystemMessage(body.messages)) {
    strict.messages = [
      {
        role: "system",
        content: systemPrompt !== undefined && systemPrompt !== "" ? systemPrompt : DEFAULT_SYSTEM_PROMPT
      },
      ...body.messages
    ];
  }
  return strict;
}

const AFFINITY_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

/** 会话粘性标识，取 prompt_cache_key，非法值不发。 */
export function affinityFor(body) {
  const raw = body?.prompt_cache_key;
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  return AFFINITY_PATTERN.test(value) ? value : "";
}

// ---------------------------------------------------------------- SSE

function intOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function strOf(value) {
  return typeof value === "string" ? value : "";
}

function floatOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function chatChunkDelta(chunk) {
  const empty = { reasoning: "", content: "", toolCalls: [] };
  const choices = chunk?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { delta: empty, finish: "" };
  const choice = choices[0];
  if (choice === null || typeof choice !== "object") return { delta: empty, finish: "" };
  const finish = strOf(choice.finish_reason);
  const rawDelta = choice.delta;
  if (rawDelta === null || typeof rawDelta !== "object") return { delta: empty, finish };
  const out = {
    reasoning: strOf(rawDelta.reasoning) || strOf(rawDelta.reasoning_content),
    content: strOf(rawDelta.content),
    toolCalls: []
  };
  if (Array.isArray(rawDelta.tool_calls)) {
    for (const item of rawDelta.tool_calls) {
      if (item === null || typeof item !== "object") continue;
      const fn = item.function !== null && typeof item.function === "object" ? item.function : undefined;
      out.toolCalls.push({
        index: intOf(item.index),
        id: strOf(item.id),
        name: strOf(fn?.name),
        args: strOf(fn?.arguments)
      });
    }
  }
  return { delta: out, finish };
}

export function chatChunkUsage(chunk) {
  const usage = chunk?.usage;
  if (usage === null || typeof usage !== "object") return undefined;
  let promptTotal = intOf(usage.prompt_tokens);
  let output = intOf(usage.completion_tokens);
  if (promptTotal === 0) promptTotal = intOf(usage.input_tokens);
  if (output === 0) output = intOf(usage.output_tokens);
  let cached = 0;
  const promptDetails = usage.prompt_tokens_details;
  if (promptDetails !== null && typeof promptDetails === "object") {
    const value = intOf(promptDetails.cached_tokens);
    if (value > 0) cached = value;
  }
  if (cached > promptTotal) cached = promptTotal;
  const input = promptTotal - cached;
  const total = intOf(usage.total_tokens) || promptTotal + output;
  if (input === 0 && output === 0 && total === 0) return undefined;
  const result = { inputTokens: input, outputTokens: output };
  if (total > 0) result.totalTokens = total;
  if (cached > 0) result.cacheReadTokens = cached;
  const completionDetails = usage.completion_tokens_details ?? usage.output_tokens_details;
  if (completionDetails !== null && typeof completionDetails === "object") {
    const reasoning = intOf(completionDetails.reasoning_tokens);
    if (reasoning > 0) result.reasoningTokens = reasoning;
  }
  let cost = floatOf(usage.cost);
  if (cost === 0 && usage.cost_details !== null && typeof usage.cost_details === "object") {
    cost = floatOf(usage.cost_details.upstream_inference_cost);
  }
  if (cost > 0) result.cost = cost;
  return result;
}

const SSE_DONE = "[DONE]";

function parseSseLine(line) {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;
  if (!trimmed.startsWith("data:")) return undefined;
  const data = trimmed.slice(5).trim();
  if (data === "") return undefined;
  if (data === SSE_DONE) return { done: true };
  try {
    const parsed = JSON.parse(data);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return { object: parsed };
  } catch {
    /* 非 JSON 帧忽略 */
  }
  return undefined;
}

/**
 * 逐帧读取 SSE。
 *
 * 用游标扫描而不是每行 slice 整个缓冲区，避免大响应下的 O(n²) 拷贝。
 */
export async function* sseFrames(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cursor = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      throw new Error("请求已中断");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    for (;;) {
      if (signal?.aborted === true) throw new Error("请求已中断");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n", cursor)) >= 0) {
        const frame = parseSseLine(buffer.slice(cursor, newline));
        cursor = newline + 1;
        if (frame === undefined) continue;
        if (frame.done === true) return;
        yield frame.object;
      }
      // 游标太靠前时压缩，避免缓冲区无限增长
      if (cursor > 65536) {
        buffer = buffer.slice(cursor);
        cursor = 0;
      }
    }
    if (cursor < buffer.length) {
      const frame = parseSseLine(buffer.slice(cursor));
      if (frame !== undefined && frame.done !== true) yield frame.object;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      /* 已经结束 */
    }
  }
}

function finishReasonOf(finish, sawToolCall) {
  if (sawToolCall && (finish === "" || finish === "tool_calls" || finish === "stop")) {
    return { kind: "tool-calls" };
  }
  switch (finish) {
    case "length":
      return { kind: "max-tokens" };
    case "tool_calls":
      return { kind: "tool-calls" };
    case "content_filter":
      return { kind: "error", failure: { message: "内容被上游过滤", code: "CONTENT_FILTERED" } };
    default:
      return { kind: "stop" };
  }
}

/**
 * 上游 SSE → DSH 流片段。
 *
 * 相对原版改成「直接生成」，不再用队列 + notify 中转，
 * 少一层每 chunk 的 Promise 分配。
 */
export async function* toStreamChunks(stream, model, signal) {
  let nextIndex = 0;
  let textIndex = -1;
  let reasoningIndex = -1;
  let textOpen = false;
  let reasoningOpen = false;
  let text = "";
  let reasoning = "";
  let finish = "";
  let usage;
  let upstreamError;
  const toolCalls = new Map();
  const toolIndexes = new Map();

  for await (const object of sseFrames(stream, signal)) {
    const errObj = object.error;
    if (errObj !== null && typeof errObj === "object") {
      upstreamError = {
        message: typeof errObj.message === "string" ? errObj.message : `${model}: 上游在流中报错`,
        code: typeof errObj.code === "string" ? errObj.code : "UPSTREAM"
      };
      break;
    }

    const { delta, finish: f } = chatChunkDelta(object);
    if (f !== "") finish = f;
    const u = chatChunkUsage(object);
    if (u !== undefined) usage = u;

    if (delta.reasoning !== "") {
      if (!reasoningOpen) {
        reasoningIndex = nextIndex++;
        reasoningOpen = true;
        yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
      }
      reasoning += delta.reasoning;
      yield { type: "reasoning-delta", index: reasoningIndex, text: delta.reasoning };
    }

    if (delta.content !== "") {
      if (reasoningOpen) {
        reasoningOpen = false;
        yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoning } };
      }
      if (!textOpen) {
        textIndex = nextIndex++;
        textOpen = true;
        yield { type: "block-start", index: textIndex, blockType: "text" };
      }
      text += delta.content;
      yield { type: "text-delta", index: textIndex, text: delta.content };
    }

    for (const tc of delta.toolCalls) {
      let slot = toolCalls.get(tc.index);
      if (slot === undefined) {
        slot = { id: "", name: "", args: "" };
        toolCalls.set(tc.index, slot);
        toolIndexes.set(tc.index, nextIndex++);
        yield { type: "block-start", index: toolIndexes.get(tc.index), blockType: "tool-call" };
      }
      if (tc.id !== "") slot.id = tc.id;
      if (tc.name !== "") slot.name = tc.name;
      slot.args += tc.args;
      yield {
        type: "tool-call-delta",
        index: toolIndexes.get(tc.index),
        id: slot.id,
        ...(slot.name !== "" ? { name: slot.name } : {}),
        argumentsDelta: tc.args
      };
    }
  }

  if (reasoningOpen) {
    yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoning } };
  }
  if (textOpen) {
    yield { type: "block-end", index: textIndex, block: { type: "text", text } };
  }
  for (const [index, slot] of toolCalls) {
    yield {
      type: "block-end",
      index: toolIndexes.get(index),
      block: { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.args }
    };
  }
  if (usage !== undefined) yield { type: "usage", usage };

  if (upstreamError !== undefined) {
    yield { type: "finish", reason: { kind: "error", failure: upstreamError } };
    return;
  }
  const unnamed = [...toolCalls.values()].filter((slot) => slot.name.trim() === "").length;
  if (unnamed > 0) {
    yield {
      type: "finish",
      reason: {
        kind: "error",
        failure: {
          message: `${model}: 上游返回了 ${unnamed} 个没有名字的工具调用，已丢弃`,
          code: "UNNAMED_TOOL_CALL"
        }
      }
    };
    return;
  }
  if (text.trim() === "" && reasoning.trim() === "" && toolCalls.size === 0 && finish !== "length") {
    yield {
      type: "finish",
      reason: { kind: "error", failure: { message: `${model}: 上游返回了空回答`, code: "EMPTY_RESPONSE" } }
    };
    return;
  }
  yield { type: "finish", reason: finishReasonOf(finish, toolCalls.size > 0) };
}
