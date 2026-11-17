/**
 * 开发期集成自检：用模拟的 cordis ctx 驱动 apply()，
 * 然后像设置页那样逐个调用路由，验证真实响应。
 *
 *   node scripts/plugintest.mjs
 */

import process from "node:process";
import { apply, inject, name } from "../lib/index.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log(`plugin name = ${name}, inject = ${JSON.stringify(inject)}`);

// ---------------------------------------------------------------- 模拟 ctx

const adapters = [];
const routes = new Map();
const logs = [];

const ctx = {
  logger: {
    info: (m) => logs.push(["info", m]),
    warn: (m) => logs.push(["warn", m]),
    error: (m) => logs.push(["error", m])
  },
  llm: {
    registerAdapter(ids, adapter) {
      adapters.push({ ids, adapter });
    }
  },
  inject(deps, fn) {
    if (deps.includes("connection")) {
      fn({
        connection: {
          fetch: {
            register({ path, methods, fetch }) {
              for (const method of methods) routes.set(`${method} ${path}`, fetch);
              return () => {
                for (const method of methods) routes.delete(`${method} ${path}`);
              };
            }
          }
        }
      });
    }
    return () => {};
  },
  emit() {}
};

const result = apply(ctx, {});
check("apply 返回 ready", typeof result?.ready?.then === "function");
await result.ready;

check("注册了 provider", adapters.length === 1, adapters[0]?.ids?.join(","));
check("已注册路由", routes.size >= 6, `${routes.size} 条`);

const adapter = adapters[0].adapter;
check("providerInfo", adapter.providerInfo("deepai").name !== "");

const models = adapter.listModels("deepai");
check("listModels 非空", models.length > 0, `${models.length} 个`);

// 等后台预热落定（车道 + 目录）
await new Promise((r) => setTimeout(r, 4000));

// ---------------------------------------------------------------- 调用路由

const call = async (route, body) => {
  const handler = routes.get(route);
  if (handler === undefined) throw new Error(`路由不存在：${route}`);
  const request = body === undefined ? undefined : new Request("http://127.0.0.1/api/deepai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const response = await handler(request);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 120)}`);
  }
  return { status: response.status, data };
};

console.log("\n== GET /status ==");
const status = await call("GET /api/deepai/status");
check("HTTP 200", status.status === 200);
const s = status.data;
check("signedIn", s.signedIn === true, s.account?.username ?? "");
check("lane 已学习", typeof s.lane === "string" && s.lane !== "", `lane ${s.lane}`);
check("machineReady", s.machineReady === true, s.machineMasked ?? "");
check("catalog 来源自洽", s.catalogLive === (s.catalogSource === "live"), `${s.catalogSource}/${s.catalogCount}`);
check("models 数组", Array.isArray(s.models) && s.models.length > 0, `${s.models?.length} 项`);
check("keyMask 打码", typeof s.account?.keyMask === "string" && s.account.keyMask.includes("…"), s.account?.keyMask ?? "");
check("proxy 信息", typeof s.proxy?.enabled === "boolean", JSON.stringify(s.proxy));
check("login 状态", s.login?.pending === false);
console.log(`  snapshot: lane=${s.lane} catalog=${s.catalogCount} timings=${JSON.stringify(s.timings)}`);

console.log("\n== POST /models/refresh ==");
const refresh = await call("POST /api/deepai/models/refresh", {});
check("refresh ok", refresh.data.ok === true, `${refresh.data.count ?? "skipped"}`);

const afterRefresh = await call("GET /api/deepai/status");
check("刷新后目录为 live", afterRefresh.data.catalogLive === true, afterRefresh.data.catalogSource);
check("刷新后 models 非空", (afterRefresh.data.models?.length ?? 0) > 0, `${afterRefresh.data.models?.length} 项`);

console.log("\n== POST /selftest ==");
const probe = await call("POST /api/deepai/selftest", { probeChat: true });
for (const step of probe.data.steps ?? []) {
  console.log(`  ${step.ok ? "ok  " : "FAIL"} ${step.label} (${step.ms}ms) ${step.detail}`);
  if (step.ok !== true) failures += 1;
}
check("selftest 全通过", probe.data.ok === true);

console.log("\n== POST /selftest (不探推理) ==");
const probe2 = await call("POST /api/deepai/selftest", { probeChat: false });
check("跳过推理也通过", probe2.data.ok === true, `${probe2.data.steps?.length} 步`);

console.log("\n== 错误路径 ==");
const badKey = await call("POST /api/deepai/key", { apiKey: "" });
check("空 Key 被拒", badKey.data.ok === false, badKey.data.error ?? "");

const badLogin = await call("POST /api/deepai/login/cancel", {});
check("cancel 幂等", badLogin.data.ok === true);

console.log("\n== 日志 ==");
for (const [level, message] of logs) console.log(`  [${level}] ${message}`);

console.log(`\n${failures === 0 ? "集成自检全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
