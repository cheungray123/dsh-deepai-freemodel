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
  const raw = String(header).trim();
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed)) return Math.min(30, Math.max(1, parsed));
  // Retry-After 也可能是 HTTP-date
  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    const seconds = Math.ceil((when - Date.now()) / 1000);
    if (seconds > 0) return Math.min(30, seconds);
  }
  return fallback;
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
      for (const block of blocksOf(message.content)) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
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
      // 历史里的思考内容不回传：DeepSeek 一类上游会把输入里的
      // `reasoning_content` 当非法字段直接 400，而其余上游也用不到它。
      out.push(assistant);
      continue;
    }

    const toolCallId = messageToolCallId(message);
    if (toolCallId !== undefined) {
      const text = flattenText(message);
      const hasImage = blocksOf(message.content).some((block) => block.type === "image");
      out.push({
        role: "tool",
        tool_call_id: toolCallId,
        // 上游不接受空 content，补个占位；图像结果至少说明「有输出被省略」
        content: text !== "" ? text : hasImage ? "(image output omitted)" : "(no output)",
        ...(message.isError === true ? { is_error: true } : {})
      });
      continue;
    }

    const inlineResults = blocksOf(message.content).filter((b) => b.type === "tool-result");
    if (inlineResults.length > 0) {
      for (const result of inlineResults) {
        const id = typeof result.toolCallId === "string" ? result.toolCallId : "";
        if (id === "") continue;
        const resultBlocks = blocksOf(result.content);
        const text = resultBlocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => String(b.text))
          .join("");
        const hasImage = resultBlocks.some((block) => block.type === "image");
        out.push({
          role: "tool",
          tool_call_id: id,
          content: text !== "" ? text : hasImage ? "(image output omitted)" : "(no output)",
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
    // OpenAI 兼容上游不一定认识 developer 角色，统一降级成 system
    const role = message.role === "user" ? "user" : "system";
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
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop;
  // 不要把 sessionId 写成 prompt_cache_key：实测 DeepAI 网关会因此打散前缀
  // 缓存（同一前缀第二次请求命中率从 ~50-75% 掉到 ~10-20%）。只有调用方
  // 显式提供 prompt_cache_key 时才由 affinityFor() 转成 X-Session-Affinity。
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

// ---------------------------------------------------------------- JSON 文本

const INVISIBLE_CHARS = /[\uFEFF\u200B\u200C\u200D\u2060]/g;
const CODE_FENCE = /```[ \t]*[A-Za-z0-9_.+-]*[ \t]*\r?\n?([\s\S]*?)```/g;

/** 严格解析一个 JSON 对象文本；数组、标量与非法 JSON 都算失败。 */
export function isJsonObjectText(text) {
  if (typeof text !== "string" || text.trim() === "") return false;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** 从 start 处的 `{` 起找到配平的对象文本，字符串内的括号不算。 */
function balancedObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

/** 收集文本里所有能独立解析成对象的子串。 */
function jsonObjectCandidates(text) {
  const candidates = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const candidate = balancedObjectAt(text, i);
    if (candidate === "") continue;
    if (isJsonObjectText(candidate)) {
      candidates.push(candidate);
    } else {
      // 模型偶尔留下 `{"a":1,}` 这类尾逗号；去掉后再试一次，仍不合法就跳过。
      const repaired = candidate.replace(/,\s*([}\]])/g, "$1");
      if (isJsonObjectText(repaired)) candidates.push(repaired);
    }
    i += candidate.length - 1;
  }
  return candidates;
}

function stripCodeFences(text) {
  return text.replace(CODE_FENCE, "$1");
}

/**
 * 从模型输出里取出一个 JSON 对象文本。
 *
 * auto-review 这类辅助调用要求正文只有一个 JSON 对象，但上游部分模型会套
 * Markdown 围栏、加前言或尾注，甚至带 BOM/零宽字符；`JSON.parse` 于是抛
 * "Unexpected token"，整个工具调用被判成审查失败。这里只做「取出合法 JSON
 * 对象」这一件事：原文已是合法 JSON 就原样返回，否则剥围栏、挑出第一个可解析
 * 的对象；都失败才退回原文，让错误信息保留现场。
 */
export function sanitizeJsonText(raw) {
  if (typeof raw !== "string") return "";
  const text = raw.replace(INVISIBLE_CHARS, "").trim();
  if (text === "") return "";
  if (isJsonObjectText(text)) return text;
  const unfenced = stripCodeFences(text).trim();
  if (unfenced !== "" && unfenced !== text && isJsonObjectText(unfenced)) return unfenced;
  const source = unfenced !== "" ? unfenced : text;
  const candidates = jsonObjectCandidates(source);
  if (candidates.length > 0) return pickDecisionCandidate(candidates);
  // 单引号 JSON（{'risk':'low',...}）不是合法 JSON，但模型偶尔会这么写
  if (source.includes("'")) {
    const fromQuotes = jsonObjectCandidates(doubleQuoted(source));
    if (fromQuotes.length > 0) return pickDecisionCandidate(fromQuotes);
  }
  return text;
}

function pickDecisionCandidate(candidates) {
  return candidates.find((candidate) => candidate.includes('"decision"')) ?? candidates[0];
}

/** 把单引号字符串改成双引号字符串，便于再走一次 JSON 解析。 */
function doubleQuoted(text) {
  return text.replace(/'((?:[^'\\\n]|\\.)*)'/g, (_, inner) => JSON.stringify(inner.replace(/\\'/g, "'")));
}

// ---------------------------------------------------------------- auto-review 决策

const REVIEW_RISKS = new Set(["low", "medium", "high"]);
const REVIEW_RISK_ALIASES = new Map([
  ["低", "low"],
  ["中", "medium"],
  ["高", "high"]
]);
const REVIEW_ALLOW_WORDS = new Set([
  "allow", "allowed", "approve", "approved", "permit", "permitted", "yes", "true",
  "允许", "同意", "通过", "放行"
]);
const REVIEW_DENY_WORDS = new Set([
  "deny", "denied", "block", "blocked", "reject", "rejected", "no", "false",
  "拒绝", "禁止", "阻止", "不允许"
]);

function wordOf(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** 大小写不敏感地取字段：模型偶尔会写成 "Risk"/"Decision"。 */
function fieldOf(record, name) {
  if (record === null || typeof record !== "object") return undefined;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) return record[key];
  }
  return undefined;
}

/** risk 取值归一：接受大小写与中文枚举。 */
function riskOf(record) {
  const word = wordOf(fieldOf(record, "risk"));
  return REVIEW_RISK_ALIASES.get(word) ?? word;
}

// 模型偶尔用「risk: low / decision: allow」这种散列写法，而不是 JSON
const PROSE_RISK = /(?:risk|风险)[^\n:：=]{0,24}\s*[:：=]?\s*["'“]?(low|medium|high|低|中|高)/i;
const PROSE_DECISION =
  /(?:decision|结论|决定|判定|verdict)[^\n:：=]{0,24}\s*[:：=]?\s*["'“]?(不允许|allow(?:ed)?|approve(?:d)?|permit(?:ted)?|deny|denied|reject(?:ed)?|block(?:ed)?|允许|同意|通过|拒绝|禁止|阻止)/i;

function decisionFromProse(text) {
  if (typeof text !== "string" || text === "") return undefined;
  const decision = PROSE_DECISION.exec(text);
  if (decision === null) return undefined;
  const risk = PROSE_RISK.exec(text);
  return risk === null
    ? JSON.stringify({ decision: decision[1] })
    : JSON.stringify({ risk: risk[1], decision: decision[1] });
}

/**
 * 把审查模型给出的对象收敛成 auto-review 协议允许的形状。
 *
 * 模型常见的偏差：allow 里多带 reason、大小写不一致、用 approve/reject 同义词、
 * 以及 high+allow、low+deny 这类矛盾组合。按「失败关闭」原则修复：
 * - allow 只保留协议允许的组合，多余字段一律丢弃；
 * - high+allow 降级为 high+deny；
 * - low+deny 保留拒绝，风险等级记为中；
 * - 缺 risk 但明确 deny 的，按 medium+deny 输出。
 * 无法安全修复（例如 allow 却没有 risk）时原样返回，让审查失败可见。
 */
export function repairAutoReviewDecision(text) {
  if (!isJsonObjectText(text)) {
    const fromProse = decisionFromProse(text);
    return fromProse === undefined ? text : repairAutoReviewDecision(fromProse);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const risk = riskOf(parsed);
  const decision = wordOf(fieldOf(parsed, "decision"));
  const rawReason = fieldOf(parsed, "reason");
  const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, 500) : "";
  const denyText = (riskValue) =>
    reason !== ""
      ? JSON.stringify({ risk: riskValue, decision: "deny", reason })
      : JSON.stringify({ risk: riskValue, decision: "deny" });

  if (REVIEW_ALLOW_WORDS.has(decision)) {
    if (!REVIEW_RISKS.has(risk)) return text;
    if (risk === "high") return denyText("high");
    return JSON.stringify({ risk, decision: "allow" });
  }
  if (REVIEW_DENY_WORDS.has(decision)) {
    if (!REVIEW_RISKS.has(risk)) return denyText("medium");
    return denyText(risk === "low" ? "medium" : risk);
  }
  return text;
}

/** 判断一段文本是否已经符合 auto-review 的决策协议。 */
export function isReviewDecisionText(text) {
  if (!isJsonObjectText(text)) return false;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const risk = riskOf(parsed);
  const decision = wordOf(fieldOf(parsed, "decision"));
  const keys = Object.keys(parsed);
  if (decision === "allow" && (risk === "low" || risk === "medium")) return keys.length === 2;
  if (decision === "deny" && (risk === "medium" || risk === "high")) {
    return keys.length === 2 || (keys.length === 3 && typeof fieldOf(parsed, "reason") === "string");
  }
  return false;
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

/** 工具调用参数的字节形态：字符串原样、对象序列化、缺失为空串。 */
function argumentsText(raw) {
  if (typeof raw === "string") return raw;
  if (raw !== undefined && raw !== null && typeof raw === "object") {
    try {
      return JSON.stringify(raw);
    } catch {
      return "";
    }
  }
  return "";
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
      const id = strOf(item.id);
      // 缺少 index 的上游按 id 归并；再不济才退到同一个槽位，避免并行调用
      // 被并进同一条参数串。
      const hasIndex = typeof item.index === "number" && Number.isFinite(item.index);
      out.toolCalls.push({
        index: intOf(item.index),
        slotKey: hasIndex ? `i${Math.trunc(item.index)}` : id !== "" ? `id:${id}` : "i0",
        id,
        name: strOf(fn?.name),
        args: argumentsText(fn?.arguments)
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
  // 兼容 DeepSeek 直连等上游的命中字段名
  if (cached === 0) {
    const hit = intOf(usage.prompt_cache_hit_tokens) || intOf(usage.cache_read_input_tokens);
    if (hit > 0) cached = hit;
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
    // 流结束时把解码器里剩下的多字节字符一起吐出，避免截断
    buffer += decoder.decode();
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
 *
 * `jsonText` 用于 auto-review 这类「正文必须只有一个 JSON 对象」的辅助调用：
 * 正文先整段缓冲，结束时归一化成一个对象再发；普通对话仍逐段流式输出。
 */
export async function* toStreamChunks(stream, model, signal, { jsonText = false } = {}) {
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
      if (!jsonText && !textOpen) {
        textIndex = nextIndex++;
        textOpen = true;
        yield { type: "block-start", index: textIndex, blockType: "text" };
      }
      text += delta.content;
      if (!jsonText) yield { type: "text-delta", index: textIndex, text: delta.content };
    }

    for (const tc of delta.toolCalls) {
      const slotKey = tc.slotKey ?? String(tc.index);
      let slot = toolCalls.get(slotKey);
      if (slot === undefined) {
        slot = { id: "", name: "", args: "" };
        toolCalls.set(slotKey, slot);
        toolIndexes.set(slotKey, nextIndex++);
        yield { type: "block-start", index: toolIndexes.get(slotKey), blockType: "tool-call" };
      }
      if (tc.id !== "") slot.id = tc.id;
      if (tc.name !== "") slot.name = tc.name;
      slot.args += tc.args;
      yield {
        type: "tool-call-delta",
        index: toolIndexes.get(slotKey),
        id: slot.id,
        ...(slot.name !== "" ? { name: slot.name } : {}),
        argumentsDelta: tc.args
      };
    }
  }

  if (reasoningOpen) {
    yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoning } };
  }
  if (jsonText) {
    // 整段缓冲后归一化：模型套围栏、加前言/尾注或漏掉正文时，仍然给出一个
    // 可解析的文本块；形状不合审查协议时按失败关闭原则收敛；正文没有可用
    // 决策时退而取推理块里的对象。
    let decision = repairAutoReviewDecision(sanitizeJsonText(text));
    if (!isReviewDecisionText(decision)) {
      const fromReasoning = repairAutoReviewDecision(sanitizeJsonText(reasoning));
      if (isReviewDecisionText(fromReasoning)) decision = fromReasoning;
    }
    if (decision !== "") {
      textIndex = nextIndex++;
      textOpen = false;
      yield { type: "block-start", index: textIndex, blockType: "text" };
      yield { type: "text-delta", index: textIndex, text: decision };
      yield { type: "block-end", index: textIndex, block: { type: "text", text: decision } };
      text = decision;
    }
  } else if (textOpen) {
    yield { type: "block-end", index: textIndex, block: { type: "text", text } };
  }
  for (const [slotKey, slot] of toolCalls) {
    yield {
      type: "block-end",
      index: toolIndexes.get(slotKey),
      // 无参工具补 "{}"，避免下游把空串当解析失败或空路径处理
      block: { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.args.trim() === "" ? "{}" : slot.args }
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
