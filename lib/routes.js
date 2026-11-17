/**
 * 设置页 API：`/api/deepai/*`。
 *
 * 全部返回 JSON，且永远 200（错误放在 `ok: false` 里）——设置页是给人看的，
 * 网络层弹红框不如就地显示原因。
 */

import { startSignIn } from "./auth.js";
import { PATH_EXCHANGE, PATH_SIGN_IN, apiUrl, DESKTOP_HEADERS } from "./protocol.js";
import { NetworkError, sendText } from "./net.js";

const MAX_BODY_BYTES = 8192;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

async function readJsonBody(request) {
  if (request === undefined || request === null) return {};
  try {
    const text = typeof request.text === "function" ? await request.text() : "";
    if (text.length > MAX_BODY_BYTES) return {};
    if (text.trim() === "") return {};
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function maskKey(key) {
  if (typeof key !== "string" || key === "") return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** 登录会话管理：只允许一个在飞。 */
class LoginManager {
  #upstream;
  #store;
  #log;
  #session;
  #url = "";
  #startedAt = 0;
  #error = "";

  constructor({ upstream, store, log }) {
    this.#upstream = upstream;
    this.#store = store;
    this.#log = log;
  }

  async exchange(code) {
    const result = await sendText(apiUrl(PATH_EXCHANGE, this.#upstream.origin), {
      method: "POST",
      headers: { ...DESKTOP_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      timeoutMs: 25000
    });
    if (!result.ok) {
      throw new Error(`换取授权失败（HTTP ${result.status}）：${result.text.trim().slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(result.text);
    } catch {
      throw new Error(`换取授权的响应不是 JSON：${result.text.slice(0, 200)}`);
    }
    const apiKey = typeof payload.api_key === "string" ? payload.api_key : typeof payload.key === "string" ? payload.key : "";
    if (apiKey.trim() === "") throw new Error("换取授权成功但响应里没有 API Key");
    return {
      apiKey: apiKey.trim(),
      username: typeof payload.username === "string" ? payload.username : "",
      isPro: payload.is_pro === true,
      obtainedAt: new Date().toISOString()
    };
  }

  async start() {
    this.cancel();
    const session = startSignIn({
      signInUrl: apiUrl(PATH_SIGN_IN, this.#upstream.origin),
      exchange: (code) => this.exchange(code)
    });
    this.#session = session;
    this.#error = "";
    this.#startedAt = Date.now();
    this.#url = await session.ready();

    void session
      .wait()
      .then(async (account) => {
        await this.#store.setAccount(account);
        this.#log?.info?.(`dsh-deepai-freemodel: 授权成功 ${account.username}`);
        this.#url = "";
        // 新 Key 到了，车道和目录都要重新确认
        void this.#upstream.ensureLane(true).catch(() => {});
        void this.#upstream.refreshModels({ force: true }).catch(() => {});
      })
      .catch((error) => {
        this.#error = error instanceof Error ? error.message : String(error);
        this.#url = "";
      })
      .finally(() => {
        if (this.#session === session) this.#session = undefined;
      });

    return this.#url;
  }

  cancel() {
    const session = this.#session;
    this.#session = undefined;
    this.#url = "";
    session?.cancel("授权已取消");
  }

  state() {
    return {
      pending: this.#session !== undefined,
      url: this.#url,
      startedAt: this.#startedAt,
      error: this.#error
    };
  }
}

export function installRoutes({ ctx, prefix, providerId = "deepai", upstream, store, adapter, log }) {
  if (typeof ctx?.inject !== "function") return;
  const login = new LoginManager({ upstream, store, log });

  const buildStatus = async () => {
    const account = await store.account();
    const snapshot = upstream.snapshot();
    const loginState = login.state();
    return {
      ok: true,
      providerId,
      displayName: adapter.providerInfo(providerId).name,
      signedIn: account !== null,
      account: account !== null
        ? {
            username: account.username,
            isPro: account.isPro,
            obtainedAt: account.obtainedAt,
            keyMask: maskKey(account.apiKey)
          }
        : null,
      models: upstream.models().map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        free: model.theosPerRequest === "0" || model.premier !== true,
        vision: (model.input ?? []).includes("image"),
        reasoning: model.reasoning === true,
        contextWindow: model.contextWindow ?? null,
        maxTokens: model.maxTokens ?? null
      })),
      login: loginState,
      ...snapshot
    };
  };

  ctx.inject(["connection"], (cctx) => {
    const register = cctx.connection?.fetch?.register;
    if (typeof register !== "function") {
      log?.warn?.("dsh-deepai-freemodel: connection fetch 注册表不可用，设置页 API 已禁用");
      return;
    }
    const disposers = [];
    const route = (path, methods, handler) => {
      try {
        disposers.push(register({ path, methods, requestBody: "buffered", fetch: handler }));
      } catch (error) {
        log?.warn?.(`dsh-deepai-freemodel: ${path} 注册失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };

    route(`${prefix}/status`, ["GET"], async () => json(await buildStatus()));

    route(`${prefix}/login`, ["POST"], async () => {
      try {
        const url = await login.start();
        return json({ ok: true, url, ...login.state() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = error instanceof NetworkError ? error.hint : undefined;
        return json({ ok: false, error: message, hint });
      }
    });

    route(`${prefix}/login/cancel`, ["POST"], async () => {
      login.cancel();
      return json({ ok: true });
    });

    route(`${prefix}/logout`, ["POST"], async () => {
      login.cancel();
      await store.clearAccount();
      await store.patchState({ lane: "" }).catch(() => {});
      log?.info?.("dsh-deepai-freemodel: 已退出登录");
      return json({ ok: true });
    });

    // 手动填 Key：给「浏览器授权走不通」留一条退路
    route(`${prefix}/key`, ["POST"], async (request) => {
      const body = await readJsonBody(request);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (apiKey === "" || apiKey.length > 512) {
        return json({ ok: false, error: "API Key 为空或过长" });
      }
      login.cancel();
      await store.setAccount({
        apiKey,
        username: typeof body.username === "string" ? body.username : "",
        isPro: false,
        obtainedAt: new Date().toISOString()
      });
      const lane = await upstream.ensureLane(true).catch((error) => {
        log?.warn?.(`dsh-deepai-freemodel: 手动 Key 车道探测失败 ${error instanceof Error ? error.message : String(error)}`);
        return "";
      });
      const models = await upstream.refreshModels({ force: true }).catch(() => ({ ok: false }));
      return json({
        ok: true,
        lane,
        models: models.ok === true ? models.count ?? 0 : 0,
        warning: models.ok === true ? undefined : "Key 已保存，但拉取模型目录失败"
      });
    });

    route(`${prefix}/models/refresh`, ["POST"], async () => {
      const result = await upstream.refreshModels({ force: true });
      return json(result);
    });

    route(`${prefix}/selftest`, ["POST"], async (request) => {
      const body = await readJsonBody(request);
      const probeChat = body.probeChat !== false;
      try {
        return json(await upstream.selftest({ probeChat }));
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error), steps: [] });
      }
    });

    return () => {
      login.cancel();
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 已经卸载 */
        }
      }
    };
  });
}
