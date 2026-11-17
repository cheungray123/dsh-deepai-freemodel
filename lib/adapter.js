/**
 * DSH 适配器：把 DeepAI Code 包装成 `deepai` provider。
 */

import { DEFAULT_SYSTEM_PROMPT, UpstreamError, buildChatBody, isReviewDecisionText, toStreamChunks } from "./protocol.js";
import { NetworkError } from "./net.js";
import { acceptsImage, isFreeModel } from "./upstream.js";

const REASONING_EFFORTS = [
  { id: "none", name: "关闭" },
  { id: "low", name: "低" },
  { id: "medium", name: "中" },
  { id: "high", name: "高" }
];

/** DSH auto-review 的请求分类：要求审查模型只回一个 JSON 对象。 */
const AUTO_REVIEW_PURPOSE = "auto-review";
/** 追加到审查系统提示末尾，降低上游模型套围栏或加前言的概率。 */
const AUTO_REVIEW_FORMAT_HINT =
  "\n\nRESPONSE FORMAT (strict): output exactly one JSON object and nothing else — " +
  "no Markdown code fences, no preamble, no explanation, no trailing text. " +
  'The only valid shapes are {"risk":"low","decision":"allow"}, {"risk":"medium","decision":"allow"}, ' +
  '{"risk":"medium","decision":"deny"}, {"risk":"high","decision":"deny"}; ' +
  'add "reason" only with deny, never with allow.';

const DEFAULT_CONTEXT_WINDOW = 131_072;
const DEFAULT_MAX_TOKENS = 32_768;

function contextWindowOf(model) {
  const value = model?.contextWindow;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  return DEFAULT_CONTEXT_WINDOW;
}

function maxTokensOf(model) {
  const value = model?.maxTokens;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  return DEFAULT_MAX_TOKENS;
}

function isResponsesEndpoint(model) {
  return model?.api === "openai-responses";
}

function displayNameOf(model) {
  if (model === undefined) return "";
  const base = model.name !== undefined && model.name !== "" ? model.name : model.id;
  return isFreeModel(model) ? `${base} · 免费` : base;
}

/** 把上游错误翻译成用户能看懂、能行动的话。 */
function describe(error) {
  if (error instanceof NetworkError) {
    const hint = error.hint !== undefined ? `\n${error.hint}` : "";
    return new Error(`deepai: ${error.message}${hint}`);
  }
  if (!(error instanceof UpstreamError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const code = error.code;
  if (code === "social_login_required") {
    return new Error(
      "deepai: 上游要求该账号改用 Google 或 Apple 登录。邮箱密码注册的账号已被禁止推理，" +
        "换号或重试都无效，请在「设置 → DeepAI 免费模型」用 Google/Apple 重新授权。"
    );
  }
  if (code === "email_unverified") {
    return new Error("deepai: 该账号邮箱未验证。去 deepai.org 验证邮箱后再试。");
  }
  if (code === "machine_required") {
    return new Error("deepai: 上游没有接受本机指纹。重启 DSH 让它重新探测，或设置 DEEPAI_MACHINE_ID 指定固定值。");
  }
  if (code === "network_bound") {
    return new Error(
      "deepai: 这条出口 IP 的免费额度已经领完。换网络/换代理节点，或等额度刷新；这不是插件问题。"
    );
  }
  if (code === "check_in_refused") {
    return new Error("deepai: 今天的签到次数用完了，上游暂时不给推理。等刷新时间到了会自动恢复。");
  }
  if (error.kind === "lane") {
    return new Error(
      "deepai: 上游不接受当前车道版本（协议已升级）。插件会自动重学车道；如果连续失败，" +
        "可能上游改了接口，需要更新插件。"
    );
  }
  if (error.kind === "auth") {
    const reason = error.status >= 300 && error.status < 400
      ? "上游把请求重定向到登录页，说明 API Key 已失效"
      : "登录态无效";
    return new Error(`deepai: ${reason}（HTTP ${error.status}）。请在「设置 → DeepAI 免费模型」重新授权。`);
  }
  if (error.kind === "busy") {
    return new Error(`deepai: 上游繁忙或排队中，稍后重试。${error.message}`);
  }
  if (error.kind === "provider") {
    return new Error(
      "deepai: 上游后端连续拒收这次请求（HTTP 400，已自动重试）。通常是该模型的提供方暂时不可用，" +
        "换个模型或隔几分钟再试；若持续出现，缩短对话或去掉附件。"
    );
  }
  return new Error(`deepai: ${error.message}`);
}

export class DeepAIAdapter {
  #providerId;
  #displayName;
  #upstream;
  #store;
  #log;

  constructor({ providerId, displayName, upstream, store, log }) {
    this.#providerId = providerId;
    this.#displayName = displayName;
    this.#upstream = upstream;
    this.#store = store;
    this.#log = log;
  }

  get upstream() {
    return this.#upstream;
  }

  providerInfo(provider) {
    return { id: provider, name: this.#displayName };
  }

  /**
   * provider 级重试策略。
   *
   * 上游容量拒绝（409 session_busy）带 Retry-After，静默吸收比直接报错好；
   * 鉴权/策略类错误不在这里，由 describe() 挡掉。
   */
  providerRetryPolicy(_provider) {
    return {
      maxRetries: 4,
      initialDelayMs: 1_000,
      maxDelayMs: 20_000,
      retryableCodes: ["RATE_LIMIT", "SERVER", "TIMEOUT", "NETWORK", "OVERLOADED"]
    };
  }

  /** 免费额度渠道不做图片计费。 */
  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  /**
   * 模型列表（选择器读这个）。
   *
   * DSH 的选择器只渲染 `name`，所以免费标记拼在名字里。
   */
  listModels(provider) {
    return this.#upstream.models().map((model) => ({
      provider,
      id: model.id,
      name: displayNameOf(model),
      inputModalities: acceptsImage(model) ? ["text", "image"] : ["text"]
    }));
  }

  resolveModel(provider, model) {
    const entry = this.#upstream.findModel(model);
    // 目录里没有这个 id 时用 id 兜底：DSH 要求 name 非空，否则会在核心里
    // 抛 INVALID_MODEL_INFO，用户只看到一个与本插件无关的错误。
    const name = displayNameOf(entry);
    const resolved = {
      provider,
      id: model,
      name: name !== "" ? name : model,
      inputModalities: acceptsImage(entry) ? ["text", "image"] : ["text"],
      context: { contextWindow: contextWindowOf(entry) },
      defaultMaxTokens: maxTokensOf(entry)
    };
    if (entry?.reasoning === true) {
      const efforts = REASONING_EFFORTS
        .filter((effort) => (isResponsesEndpoint(entry) ? effort.id !== "none" : true))
        .map((effort) => ({ id: effort.id, name: effort.name }));
      resolved.reasoning = { efforts };
    }
    return resolved;
  }

  /** 每次调用前：确认凭据/车道就绪，返回能力描述与 stream 句柄。 */
  async prepareCall(provider, model, signal) {
    if (signal?.aborted === true) throw new Error("deepai: 请求已取消");
    const account = await this.#store.account();
    if (account === null) {
      throw new Error("deepai: 还没登录，请在「设置 → DeepAI 免费模型」完成一次授权");
    }
    if (this.#upstream.models().length === 0) await this.#upstream.refreshModels();
    // 车道已落盘时这一步是纯内存读；没有就顺手学一次
    await this.#upstream.ensureLane().catch(() => {});
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.#stream(model, options)
    };
  }

  async *#stream(model, options) {
    const entry = this.#upstream.findModel(model);
    if (entry === undefined) {
      const known = this.#upstream.models().map((m) => m.id).join(", ");
      throw new Error(`deepai: 未知模型 "${model}"（可用：${known}）`);
    }
    await this.#upstream.ensureCheckIn(options.signal);

    // 审查请求的正文契约是「只有一个 JSON 对象」：补一句格式约束，并在
    // 流式侧归一化输出，避免上游模型套围栏/加前言时审查直接失败。
    // 旧版 DSH 可能不传 purpose，退回按审查策略的系统提示识别。
    const autoReview =
      options.purpose === AUTO_REVIEW_PURPOSE ||
      (typeof options.system === "string" && options.system.startsWith("REVIEW_POLICY"));
    const basePrompt = typeof options.system === "string" && options.system !== "" ? options.system : DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = autoReview ? `${basePrompt}${AUTO_REVIEW_FORMAT_HINT}` : options.system;

    let stream;
    try {
      stream = await this.#upstream.chat({ body: buildChatBody(options, entry.id, systemPrompt), signal: options.signal, systemPrompt });
    } catch (error) {
      // 车道刚被上游作废：重学一次再试，用户无感
      if (error instanceof UpstreamError && error.kind === "lane") {
        await this.#upstream.invalidateLane().catch(() => {});
        await this.#upstream.ensureLane(true).catch(() => {});
        try {
          stream = await this.#upstream.chat({
            body: buildChatBody(options, entry.id, systemPrompt),
            signal: options.signal,
            systemPrompt
          });
        } catch (retryError) {
          throw describe(retryError);
        }
      } else {
        throw describe(error);
      }
    }

    try {
      if (autoReview) {
        yield* this.#reviewChunks(stream, model, options, systemPrompt);
      } else {
        for await (const chunk of toStreamChunks(stream, model, options.signal)) yield chunk;
      }
    } catch (error) {
      throw describe(error);
    }
  }

  /**
   * 审查请求的输出处理：先归一化，形状不可用就追加更强指令再问一次。
   *
   * 上游模型偶尔完全不按 JSON 回答（例如用中文散文解释），这时单纯提取
   * 救不回来；再问一次并给出兜底答案，比直接让工具调用失败更划算。
   */
  async *#reviewChunks(stream, model, options, systemPrompt) {
    const collect = async (source) => {
      const chunks = [];
      for await (const chunk of toStreamChunks(source, model, options.signal, { jsonText: true })) chunks.push(chunk);
      return chunks;
    };
    const textOf = (chunks) =>
      chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "text")?.block.text ?? "";

    const first = await collect(stream);
    if (isReviewDecisionText(textOf(first))) {
      yield* first;
      return;
    }

    this.#log?.warn?.(
      `dsh-deepai-freemodel: 审查输出不是协议 JSON，重试一次：${String(textOf(first)).slice(0, 200)}`
    );

    const retryPrompt =
      `${systemPrompt}\n\nCRITICAL: reply with exactly one JSON object and nothing else. ` +
      'Valid replies: {"risk":"low","decision":"allow"}, {"risk":"medium","decision":"allow"}, ' +
      '{"risk":"medium","decision":"deny"}, {"risk":"high","decision":"deny"}. ' +
      'If unsure, reply {"risk":"medium","decision":"deny"}. Do not write any sentence.';
    const retryOptions = {
      ...options,
      messages: [
        ...options.messages,
        { role: "user", content: [{ type: "text", text: "Return only the JSON decision object now." }] }
      ]
    };

    let second;
    try {
      const retryStream = await this.#upstream.chat({
        body: buildChatBody(retryOptions, model, retryPrompt),
        signal: options.signal,
        systemPrompt: retryPrompt
      });
      second = await collect(retryStream);
    } catch {
      // 重试请求本身失败时保留第一份，让原来的错误继续暴露
      yield* first;
      return;
    }
    if (isReviewDecisionText(textOf(second))) {
      yield* second;
      return;
    }
    this.#log?.warn?.(`dsh-deepai-freemodel: 审查重试仍不是协议 JSON：${String(textOf(second)).slice(0, 200)}`);
    yield* first;
  }
}
