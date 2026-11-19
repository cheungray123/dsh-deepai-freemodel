/**
 * 插件入口。
 *
 * 启动路径刻意做成「立即返回、后台预热」：
 * `ready` 马上 resolve，车道/目录在后台补。这样 DSH 起来不会等网络，
 * 而用户打开设置页时状态已经就绪。
 */

import { PluginStore, adoptLegacyData, defaultDataDir, legacyDataDir } from "./store.js";
import { Upstream } from "./upstream.js";
import { DeepAIAdapter } from "./adapter.js";
import { installRoutes } from "./routes.js";
import { normalizeOrigin, PATH_MODELS, apiUrl } from "./protocol.js";
import { configureEgress, egressInfo, proxyInfo, warmEgress } from "./net.js";

export const name = "dsh-deepai-freemodel";
export const inject = ["llm"];

const API_PREFIX = "/api/deepai";
const DEFAULT_PROVIDER_ID = "deepai";

function resolveConfig(config = {}, env = process.env) {
  const pick = (raw, fallback) => {
    const value = typeof raw === "string" ? raw.trim() : "";
    return value !== "" ? value : fallback;
  };
  return {
    providerId: pick(config.providerId, DEFAULT_PROVIDER_ID),
    displayName: pick(config.displayName, "DeepAI Code"),
    dataDir: pick(config.dataDir, defaultDataDir(env)),
    apiOrigin: normalizeOrigin(config.apiOrigin ?? env.DEEPAI_API_ORIGIN),
    proxy: pick(config.proxy, pick(env.DEEPAI_PROXY, ""))
  };
}

function makeLogger(ctx) {
  const source = ctx?.logger;
  const wrap = (fn) => (message) => {
    try {
      fn(message);
    } catch {
      /* 日志不该影响主流程 */
    }
  };
  return {
    info: wrap(source?.info?.bind(source) ?? ((m) => console.log(m))),
    warn: wrap(source?.warn?.bind(source) ?? ((m) => console.warn(m))),
    error: wrap(source?.error?.bind(source) ?? ((m) => console.error(m)))
  };
}

export function apply(ctx, config = {}) {
  const log = makeLogger(ctx);
  const ready = Promise.resolve({ version: "adapter" });

  try {
    const cfg = resolveConfig(config);
    if (!ctx?.llm || typeof ctx.llm.registerAdapter !== "function") {
      log.error("dsh-deepai-freemodel: llm 服务不可用，适配器无法注册");
      return { ready };
    }

    const store = new PluginStore(cfg.dataDir);
    // 出口要在第一个请求之前配好：显式代理 > 环境变量 > 自动探测本机代理
    configureEgress({ proxy: cfg.proxy, log });
    const upstream = new Upstream({ store, origin: cfg.apiOrigin, log });
    const adapter = new DeepAIAdapter({
      providerId: cfg.providerId,
      displayName: cfg.displayName,
      upstream,
      store,
      log
    });

    try {
      ctx.llm.registerAdapter([cfg.providerId], adapter);
      log.info(`dsh-deepai-freemodel: 已注册 provider "${cfg.providerId}"`);
    } catch (error) {
      log.error(
        `dsh-deepai-freemodel: provider "${cfg.providerId}" 注册失败（可能与已装插件同名）：` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return { ready };
    }

    installRoutes({ ctx, prefix: API_PREFIX, providerId: cfg.providerId, upstream, store, adapter, log });

    void (async () => {
      // 插件改过名，先看能不能接管旧目录里的凭据，省掉一次重新授权
      const adopted = await adoptLegacyData(cfg.dataDir).catch(() => false);
      if (adopted) {
        log.info(`dsh-deepai-freemodel: 已从 ${legacyDataDir()} 接管旧凭据`);
      }
      await upstream.boot();
      // 出口判断会花几百毫秒（要探一次直连），放后台跑：
      // 用户第一次点「登录」时结果已经就绪，不用在回调里等。
      void warmEgress(apiUrl(PATH_MODELS, cfg.apiOrigin)).then(() => {
        const egress = egressInfo();
        const label =
          egress.mode === "proxy"
            ? `经本机代理 ${egress.proxy}`
            : egress.mode === "env"
              ? `经环境变量代理 ${egress.env.url}`
              : "直连上游";
        log.info(`dsh-deepai-freemodel: 出口 ${label}${egress.detail !== "" ? `（${egress.detail}）` : ""}`);
      });
      const proxy = proxyInfo();
      if (!proxy.enabled && proxy.configured && cfg.proxy === "") {
        log.warn(
          `dsh-deepai-freemodel: 检测到 HTTPS_PROXY=${proxy.url}，但 NODE_USE_ENV_PROXY 未设为 1；` +
            "插件会自己探测本机代理，一般不必再补这个开关"
        );
      }
      const account = await store.account();
      if (account === null) {
        log.info("dsh-deepai-freemodel: 还没有登录，请在「设置 → DeepAI 免费模型」完成授权");
        return;
      }
      log.info(`dsh-deepai-freemodel: 已加载账号 ${account.username !== "" ? account.username : "(无用户名)"}`);
      const before = upstream.models().length;
      const lane = await upstream.ensureLane().catch((error) => {
        log.warn(`dsh-deepai-freemodel: 车道握手失败 ${error instanceof Error ? error.message : String(error)}`);
        return "";
      });
      if (lane !== "") log.info(`dsh-deepai-freemodel: 车道 ${lane}`);
      const refreshed = await upstream.refreshModels();
      if (refreshed.ok === true && upstream.models().length !== before) {
        emitSafe(ctx, "llm/models-updated", cfg.providerId);
      }
      const sourceLabel = upstream.catalogLive ? "上游" : "本地缓存";
      log.info(`dsh-deepai-freemodel: 模型目录 ${upstream.models().length} 项（${sourceLabel}）`);
    })().catch((error) => {
      log.error(`dsh-deepai-freemodel: 初始化失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    });

    return { ready };
  } catch (error) {
    log.error(
      `dsh-deepai-freemodel: 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
    return { ready };
  }
}

function emitSafe(ctx, event, ...args) {
  try {
    ctx.emit?.(event, ...args);
  } catch {
    /* 事件总线不在就跳过 */
  }
}
