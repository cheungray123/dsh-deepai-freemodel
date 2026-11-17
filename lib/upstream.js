/**
 * 上游客户端：车道、模型目录、签到、chat。
 *
 * 设计要点（相对原版的改动）：
 * - 车道**落盘**：冷启动先试上次成功的车道，一次请求就能确认，
 *   不用每次从 4 开始串行试到 7。
 * - 车道探测**区分鉴权失败**：401/403/30x 不再被当成「车道不对」，
 *   否则会把「Key 失效」误报成「插件需要更新」。
 * - 模型目录**落盘 + 后台刷新**：启动瞬间就有列表，TTL 到期再静默更新。
 * - 所有请求共用一套超时/错误归一化。
 */

import { randomBytes } from "node:crypto";
import {
  APP_VERSION,
  HEADER_AFFINITY,
  HEADER_BEACON,
  HEADER_CHECK_IN,
  HEADER_INSTANCE,
  HEADER_KEY,
  HEADER_LANE,
  HEADER_MACHINE,
  LANE_CANDIDATES,
  LANE_FALLBACK,
  DESKTOP_HEADERS,
  PATH_CHAT,
  PATH_MODELS,
  PATH_THEOS,
  UpstreamError,
  affinityFor,
  apiUrl,
  buildChatBody,
  classify,
  errorCodeOf,
  errorMessageOf,
  strictChatBody
} from "./protocol.js";
import { NetworkError, proxyInfo, sendStream, sendText, withRetry } from "./net.js";
import { detectMachineFingerprint } from "./machine.js";

const CHECK_IN_MIN_INTERVAL_MS = 30_000;
const CHECK_IN_TIMEOUT_MS = 10_000;
const CHECK_IN_REFUSED_LOCK_MS = 6 * 60 * 60 * 1_000;
const CATALOG_TTL_MS = 6 * 60 * 60 * 1_000;
const LANE_PROBE_TIMEOUT_MS = 15_000;
const MODELS_TIMEOUT_MS = 20_000;
const CHAT_PROBE_TIMEOUT_MS = 90_000;

const FALLBACK_MODELS = Object.freeze([
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_072, theosPerRequest: "0" },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_072, theosPerRequest: "0" },
  { id: "mimo-2.6-flash", name: "MiMo 2.6 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_072, theosPerRequest: "0" },
  { id: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 128_000, theosPerRequest: "0" }
]);

export function isFreeModel(model) {
  if (model?.theosPerRequest !== undefined) {
    const value = Number.parseFloat(model.theosPerRequest);
    if (Number.isFinite(value)) return value === 0;
  }
  return model?.premier !== true;
}

export function acceptsImage(model) {
  return Array.isArray(model?.input) && model.input.includes("image");
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

function normalizeModel(raw) {
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  if (id === "") return undefined;
  const model = { id };
  if (typeof raw.name === "string") model.name = raw.name;
  if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
  if (Array.isArray(raw.input)) model.input = raw.input.filter((v) => typeof v === "string");
  if (typeof raw.contextWindow === "number") model.contextWindow = raw.contextWindow;
  if (typeof raw.maxTokens === "number") model.maxTokens = raw.maxTokens;
  if (typeof raw.premier === "boolean") model.premier = raw.premier;
  if (typeof raw.api === "string") model.api = raw.api;
  if (typeof raw.theosPerRequest === "string") model.theosPerRequest = raw.theosPerRequest;
  return model;
}

function isValidCheckIn(challenge) {
  if (challenge === undefined) return false;
  const nonce = typeof challenge.nonce === "string" ? challenge.nonce.trim() : "";
  return nonce !== "" && nonce.length <= 512 && typeof challenge.seconds === "number" && challenge.seconds > 0;
}

function nowSeconds(from) {
  return Math.max(0, Math.floor((Date.now() - from) / 1000));
}

export class Upstream {
  #origin;
  #store;
  #log;

  #instance = randomBytes(16).toString("hex");
  #machine = "";
  #lane;
  #lanePromise;
  #modelsPromise;
  #checkInPromise;

  #catalog = { models: FALLBACK_MODELS, fetchedAt: 0, source: "fallback" };
  #checkIns = new Map();
  #startedAt = Date.now();
  #lastError = "";
  #timings = {};
  #lastLaneProbe = 0;

  constructor({ store, origin, log }) {
    this.#store = store;
    this.#origin = origin;
    this.#log = log;
  }

  get origin() {
    return this.#origin;
  }

  get instanceId() {
    return this.#instance;
  }

  get lane() {
    return this.#lane;
  }

  get catalog() {
    return this.#catalog;
  }

  get lastError() {
    return this.#lastError;
  }

  get timings() {
    return this.#timings;
  }

  /** 启动预热：读落盘的车道与目录，异步补机器指纹，空窗期不阻塞。 */
  async boot() {
    const state = await this.#store.state();
    if (typeof state.lane === "string" && state.lane !== "") this.#lane = state.lane;
    const cached = state.catalog;
    if (cached !== undefined && Array.isArray(cached.models) && cached.models.length > 0) {
      this.#catalog = {
        models: cached.models.map(normalizeModel).filter(Boolean),
        fetchedAt: typeof cached.fetchedAt === "number" ? cached.fetchedAt : 0,
        source: "cache"
      };
    }
    void detectMachineFingerprint()
      .then((fingerprint) => {
        if (fingerprint !== "") this.#machine = fingerprint;
      })
      .catch(() => {});
  }

  async machine() {
    if (this.#machine !== "") return this.#machine;
    try {
      this.#machine = await detectMachineFingerprint();
    } catch {
      this.#machine = "";
    }
    return this.#machine;
  }

  async account() {
    return this.#store.account();
  }

  async apiKey() {
    return (await this.#store.account())?.apiKey ?? "";
  }

  #headers({ key = "", lane = this.#lane ?? LANE_FALLBACK, affinity = "" } = {}) {
    const headers = {
      ...DESKTOP_HEADERS,
      "Content-Type": "application/json",
      [HEADER_LANE]: String(lane),
      [HEADER_INSTANCE]: this.#instance
    };
    if (this.#machine !== "") headers[HEADER_MACHINE] = this.#machine;
    if (key !== "") headers[HEADER_KEY] = key;
    if (affinity !== "") headers[HEADER_AFFINITY] = affinity;
    return headers;
  }

  #errorOf(result, operation) {
    const code = errorCodeOf(result.text);
    const detail = errorMessageOf(result.text);
    const status = result.status;
    // 重定向一律视为鉴权问题；其余交给统一分类，避免这里和 net.js 两套规则漂移
    const kind = isRedirect(status) ? "auth" : classify(status, code, result.text);

    const suffix = status === 0 ? "" : `（HTTP ${status}）`;
    return new UpstreamError({
      status,
      code,
      kind,
      body: result.text,
      retryAfter: Number.parseInt(result.headers?.get?.("retry-after") ?? "", 10) || undefined,
      message: `${operation}失败${suffix}${detail !== "" ? `：${detail}` : ""}`
    });
  }

  // ------------------------------------------------------------ 车道

  /**
   * 确保有可用车道。
   *
   * 有值直接返回；没有就探测一次，并发调用共享同一次探测。
   * `force` 用于「上游提示车道不对」后重新学习。
   */
  async ensureLane(force = false) {
    if (!force && this.#lane !== undefined && this.#lane !== "") return this.#lane;
    if (this.#lanePromise !== undefined) return this.#lanePromise;
    this.#lanePromise = this.#probeLane().finally(() => {
      this.#lanePromise = undefined;
    });
    return this.#lanePromise;
  }

  async #probeLane() {
    const state = await this.#store.state();
    const persisted = typeof state.lane === "string" ? state.lane : "";
    const key = await this.apiKey();
    const order = [...new Set([persisted, ...LANE_CANDIDATES].filter((v) => v !== ""))];

    let laneError;
    for (const lane of order) {
      const started = Date.now();
      let result;
      try {
        result = await sendText(apiUrl(PATH_MODELS, this.#origin), {
          headers: this.#headers({ key, lane }),
          timeoutMs: LANE_PROBE_TIMEOUT_MS,
          redirect: "manual"
        });
      } finally {
        this.#timings.laneProbe = Date.now() - started;
      }
      this.#lastLaneProbe = Date.now();

      if (result.ok || result.status === 401 || result.status === 403 || isRedirect(result.status)) {
        // 200 = 车道可用（能返回内容）；401/403/30x = 问题在鉴权，不在车道。
        if (key === "") {
          // 没登录时无法用 /models 判定，先沿用已知值，等登录后自然会再确认
          this.#lane = persisted !== "" ? persisted : LANE_FALLBACK;
          return this.#lane;
        }
        await this.#setLane(lane);
        return lane;
      }
      if (result.status === 426) {
        laneError = this.#errorOf(result, "探测车道");
        continue;
      }
      throw this.#errorOf(result, "探测车道");
    }
    this.#lane = persisted !== "" ? persisted : LANE_FALLBACK;
    throw laneError ?? new UpstreamError({ status: 0, kind: "lane", message: "没有可用车道，上游可能已升级协议" });
  }

  async #setLane(lane) {
    if (this.#lane === lane) return;
    this.#lane = lane;
    try {
      await this.#store.patchState({ lane });
    } catch (error) {
      this.#log?.warn?.(`deepai: 车道落盘失败 ${String(error)}`);
    }
  }

  /** 上游说车道不对时调用：作废当前值并重学。 */
  async invalidateLane() {
    this.#lane = undefined;
    await this.#store.patchState({ lane: "" });
  }

  // ------------------------------------------------------------ 模型目录

  /** 同步取目录（给选择器用）。 */
  models() {
    return this.#catalog.models;
  }

  findModel(id) {
    return this.#catalog.models.find((model) => model.id === id);
  }

  /** 目录是否本次进程内真的从上游拉过（缓存不算）。 */
  get catalogLive() {
    return this.#catalog.source === "live";
  }

  /**
   * 刷新目录。失败不抛错——目录只是选择器内容，不该让界面报错；
   * 结果记在 `lastError` 里，设置页能看到。
   */
  async refreshModels({ force = false } = {}) {
    const age = Date.now() - this.#catalog.fetchedAt;
    if (!force && this.#catalog.fetchedAt > 0 && age < CATALOG_TTL_MS) return { ok: true, skipped: true };
    if (this.#modelsPromise !== undefined) return this.#modelsPromise;
    this.#modelsPromise = this.#fetchModels().finally(() => {
      this.#modelsPromise = undefined;
    });
    return this.#modelsPromise;
  }

  async #fetchModels() {
    const started = Date.now();
    try {
      await this.ensureLane().catch(() => {});
      const key = await this.apiKey();
      const result = await sendText(apiUrl(PATH_MODELS, this.#origin), {
        headers: this.#headers({ key }),
        timeoutMs: MODELS_TIMEOUT_MS,
        redirect: "manual"
      });
      this.#timings.models = Date.now() - started;
      if (!result.ok) {
        const error = this.#errorOf(result, "拉取模型目录");
        this.#lastError = error.message;
        return { ok: false, error: error.message, kind: error.kind };
      }
      let payload;
      try {
        payload = JSON.parse(result.text);
      } catch {
        this.#lastError = "模型目录返回了非 JSON 响应";
        return { ok: false, error: this.#lastError, kind: "other" };
      }
      const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
      const models = list.map(normalizeModel).filter(Boolean);
      if (models.length === 0) {
        this.#lastError = "上游返回了空模型列表";
        return { ok: false, error: this.#lastError, kind: "other" };
      }
      this.#catalog = { models, fetchedAt: Date.now(), source: "live" };
      this.#lastError = "";
      try {
        await this.#store.patchState({ catalog: { models, fetchedAt: this.#catalog.fetchedAt } });
      } catch {
        /* 缓存写失败不影响本次使用 */
      }
      return { ok: true, count: models.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#lastError = message;
      return { ok: false, error: message, kind: error instanceof UpstreamError ? error.kind : "network" };
    }
  }

  // ------------------------------------------------------------ 签到

  #checkInState(key) {
    let state = this.#checkIns.get(key);
    if (state === undefined) {
      state = { challenge: undefined, notedAt: 0, attemptedAt: 0, ackedNonce: "", refusedUntil: 0, lastRelay: 0 };
      this.#checkIns.set(key, state);
    }
    return state;
  }

  markRelay() {
    void this.apiKey().then((key) => {
      if (key !== "") this.#checkInState(key).lastRelay = Date.now();
    });
  }

  #beacon(state) {
    const challenge = state.challenge;
    const ttl = challenge !== undefined && challenge.seconds > 0 ? challenge.seconds : 600;
    const relayed = state.lastRelay > 0 && Date.now() - state.lastRelay < ttl * 1_000;
    return `v=${APP_VERSION};up=${nowSeconds(this.#startedAt)};pi=${relayed ? 1 : 0}`;
  }

  #captureChallenge(key, body) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    const raw = parsed?.check_in;
    if (raw === null || typeof raw !== "object") return;
    const nonce = typeof raw.nonce === "string" ? raw.nonce.trim() : "";
    const seconds = typeof raw.seconds === "number" ? raw.seconds : 0;
    const challenge = { nonce, seconds };
    if (!isValidCheckIn(challenge)) return;
    const state = this.#checkInState(key);
    state.challenge = challenge;
    state.notedAt = Date.now();
  }

  /** 查一次 Theos（顺带回传签到 nonce）。 */
  async theos(signal) {
    const key = await this.apiKey();
    if (key === "") throw new UpstreamError({ status: 401, kind: "auth", message: "尚未登录 DeepAI Code" });
    const state = this.#checkInState(key);
    const headers = this.#headers({ key });
    if (state.challenge?.nonce) headers[HEADER_CHECK_IN] = state.challenge.nonce;
    headers[HEADER_BEACON] = this.#beacon(state);
    const sentNonce = headers[HEADER_CHECK_IN] ?? "";

    const result = await sendText(apiUrl(PATH_THEOS, this.#origin), {
      headers,
      timeoutMs: MODELS_TIMEOUT_MS,
      redirect: "manual",
      signal
    });
    state.attemptedAt = Date.now();
    this.#captureChallenge(key, result.text);

    if (!result.ok) {
      const error = this.#errorOf(result, "查询 Theos");
      if (error.code === "check_in_refused" || error.kind === "policy") {
        state.refusedUntil = Date.now() + CHECK_IN_REFUSED_LOCK_MS;
      }
      throw error;
    }
    // 只有签到真的成功才记 ack；失败时标记成功会让后续请求少带 nonce，
    // 反而更容易被上游当成非客户端。
    if (sentNonce !== "") state.ackedNonce = sentNonce;
    let payload;
    try {
      payload = JSON.parse(result.text);
    } catch {
      throw new UpstreamError({ status: result.status, kind: "other", message: "Theos 响应不是 JSON" });
    }
    const allowance = {};
    if (typeof payload.balance === "number") allowance.balance = payload.balance;
    if (typeof payload.granted === "number") allowance.granted = payload.granted;
    const refreshAt = payload.refresh_at ?? payload.refreshAt;
    if (typeof refreshAt === "string") allowance.refreshAt = refreshAt;
    if (state.challenge !== undefined) allowance.checkIn = state.challenge;
    return allowance;
  }

  /**
   * 推理前确保签到完成。
   *
   * 签到只影响「请求是否被当作真客户端」，失败不阻塞推理。
   */
  async ensureCheckIn(signal) {
    const key = await this.apiKey();
    if (key === "") return;
    if (this.#checkInPromise !== undefined) return this.#checkInPromise;
    const state = this.#checkInState(key);
    const now = Date.now();
    if (state.refusedUntil > 0 && now < state.refusedUntil) return;
    const challenge = state.challenge;
    const hasChallenge = isValidCheckIn(challenge);
    const needAck = hasChallenge && challenge.nonce !== state.ackedNonce;
    if (hasChallenge && !needAck && now - state.notedAt < (challenge.seconds * 1_000) / 2) return;
    if (state.attemptedAt > 0 && now - state.attemptedAt < CHECK_IN_MIN_INTERVAL_MS) return;

    this.#checkInPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHECK_IN_TIMEOUT_MS);
      // 调用方的 signal 与超时信号必须同时生效：只传调用方 signal 时，
      // 签到一旦卡住就会把整次推理一起拖死。
      const timeoutSignal = controller.signal;
      const merged = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      try {
        await this.theos(merged);
      } catch {
        /* 签到失败不阻塞推理 */
      } finally {
        clearTimeout(timer);
        this.#checkInPromise = undefined;
      }
    })();
    return this.#checkInPromise;
  }

  // ------------------------------------------------------------ chat

  /**
   * 发起 chat 请求，返回上游 SSE 流。
   *
   * 形状兜底：只有上游明确说「请求体不合法」时才按桌面端白名单重发一次。
   */
  async chat({ body, signal, systemPrompt }) {
    const affinity = affinityFor(body);
    const key = await this.apiKey();

    const post = (payload, operation) =>
      sendStream(apiUrl(PATH_CHAT, this.#origin), {
        method: "POST",
        headers: this.#headers({ key, affinity }),
        body: JSON.stringify(payload),
        signal,
        // 流式响应可能生成很久：不设总超时，交给 DSH 的 abort 信号
        timeoutMs: 0,
        // 上游对失效 Key 会 302 到登录页，跟随会把鉴权失败伪装成 200
        redirect: "manual",
        operation
      });

    try {
      // 上游后端偶发 400「provider rejected」，同一报文重发通常就正常
      const result = await withRetry(() => post(body, "请求 chat"), {
        attempts: 3,
        baseMs: 700,
        maxMs: 3_000,
        signal,
        onRetry: (error, delay, attempt) => {
          this.#log?.warn?.(
            `dsh-deepai-freemodel: 上游拒收（kind=${error.kind}），${delay}ms 后第 ${attempt} 次重试`
          );
        }
      });
      this.markRelay();
      return result.body;
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === "body") {
        const strict = strictChatBody(body, systemPrompt);
        if (strict !== undefined) {
          // 回退请求同样可能遇到上游偶发拒收，给一次轻量重试
          const retry = await withRetry(() => post(strict, "形状回退后请求 chat"), {
            attempts: 2,
            baseMs: 500,
            maxMs: 2_000,
            signal
          });
          this.markRelay();
          return retry.body;
        }
      }
      throw error;
    }
  }

  /** 非流式：把 SSE 拼成完整回答。 */
  async complete({ body, signal, systemPrompt }) {
    const { toStreamChunks } = await import("./protocol.js");
    const stream = await this.chat({ body: { ...body, stream: true }, signal, systemPrompt });
    let text = "";
    let reasoning = "";
    let usage;
    for await (const chunk of toStreamChunks(stream, body.model, signal)) {
      if (chunk.type === "text-delta") text += chunk.text;
      else if (chunk.type === "reasoning-delta") reasoning += chunk.text;
      else if (chunk.type === "usage") usage = chunk.usage;
      else if (chunk.type === "finish" && chunk.reason?.kind === "error") {
        throw new UpstreamError({ status: 0, kind: "other", message: chunk.reason.failure?.message ?? "上游返回错误" });
      }
    }
    return { text, reasoning, usage };
  }

  // ------------------------------------------------------------ 诊断

  /** 设置页用的状态快照。同步、不发起请求。 */
  snapshot() {
    return {
      lane: this.#lane ?? "",
      machineReady: this.#machine !== "",
      machineMasked: this.#machine !== "" ? `${this.#machine.slice(0, 8)}…${this.#machine.slice(-4)}` : "",
      catalogLive: this.catalogLive,
      catalogSource: this.#catalog.source,
      catalogCount: this.#catalog.models.length,
      catalogFetchedAt: this.#catalog.fetchedAt,
      lastError: this.#lastError,
      timings: this.#timings,
      lastLaneProbe: this.#lastLaneProbe,
      upstream: this.#origin,
      instance: `${this.#instance.slice(0, 8)}…`,
      proxy: proxyInfo(),
      uptimeSeconds: nowSeconds(this.#startedAt)
    };
  }

  /**
   * 端到端自检：每一步独立计时、独立报错。
   * 面向「为什么不能用了」，而不是抛一个笼统的失败。
   */
  async selftest({ probeChat = true } = {}) {
    const steps = [];
    const record = async (id, label, fn) => {
      const started = Date.now();
      try {
        const detail = await fn();
        steps.push({ id, label, ok: true, ms: Date.now() - started, detail: detail ?? "" });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = error instanceof NetworkError ? error.hint : undefined;
        steps.push({ id, label, ok: false, ms: Date.now() - started, detail: message, hint });
        return false;
      }
    };

    await record("machine", "机器指纹", async () => {
      const fingerprint = await this.machine();
      if (fingerprint === "") throw new Error("未取到机器指纹（不影响登录，但会少一层设备识别）");
      return `${fingerprint.slice(0, 8)}…`;
    });

    const account = await this.account();
    await record("account", "账号凭据", async () => {
      if (account === null) throw new Error("尚未登录");
      return account.username !== "" ? account.username : "已保存 API Key";
    });

    await record("lane", "车道握手", async () => {
      // 未登录时 /models 无法判定车道，硬探只会得到一个误导性的「通过」
      if (account === null) return "未登录，跳过";
      const lane = await this.ensureLane(true);
      return `lane ${lane}`;
    });

    await record("models", "模型目录", async () => {
      const result = await this.refreshModels({ force: true });
      if (result.ok !== true) throw new Error(result.error ?? "拉取失败");
      return `${result.count ?? this.#catalog.models.length} 个模型`;
    });

    if (probeChat && account !== null) {
      await record("chat", "推理链路", async () => {
        const model = this.#catalog.models[0]?.id;
        if (model === undefined) throw new Error("没有可用模型");
        const body = {
          model,
          messages: [
            { role: "system", content: "You are a helpful AI assistant." },
            { role: "user", content: "ping" }
          ],
          stream: true,
          stream_options: { include_usage: true },
          store: false,
          max_completion_tokens: 64
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CHAT_PROBE_TIMEOUT_MS);
        try {
          const { text, reasoning } = await this.complete({ body, signal: controller.signal });
          const answer = text.trim() !== "" ? text.trim() : reasoning.trim();
          if (answer === "") throw new Error("上游返回了空回答");
          return answer.slice(0, 40);
        } finally {
          clearTimeout(timer);
        }
      });
    }

    return { ok: steps.every((step) => step.ok), steps, snapshot: this.snapshot() };
  }
}

export { FALLBACK_MODELS, buildChatBody, CATALOG_TTL_MS, HEADER_KEY, HEADER_LANE, HEADER_MACHINE, HEADER_INSTANCE };
