/**
 * 开发期自检脚本（不打进插件包）。
 *
 *   node scripts/selftest.mjs
 *
 * 需要真实凭据与可用代理：走一遍「车道 → 目录 → 推理」。
 */

import process from "node:process";
import { PluginStore, adoptLegacyData, defaultDataDir } from "../lib/store.js";
import { Upstream } from "../lib/upstream.js";
import { DeepAIAdapter } from "../lib/adapter.js";
import { buildChatBody, toOpenAIMessages, normalizeOrigin, UpstreamError, classify } from "../lib/protocol.js";

const log = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.warn(`[warn] ${m}`),
  error: (m) => console.error(`[error] ${m}`)
};

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("== 1. 纯函数 ==");
const body = buildChatBody(
  { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxTokens: 64, reasoningEffort: "none" },
  "deepseek-v4.1-flash"
);
check("自动补 system", body.messages[0].role === "system", body.messages[0].content.slice(0, 24));
check("stream_options", body.stream_options?.include_usage === true);
check("max_completion_tokens", body.max_completion_tokens === 64);
check("reasoning_effort=none", body.reasoning_effort === "none");

const converted = toOpenAIMessages([
  { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a"}' }] },
  { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "data" }] }
]);
check("tool_calls 结构", converted[0].tool_calls?.[0]?.function?.name === "read");
check("tool 消息", converted[1].role === "tool" && converted[1].tool_call_id === "c1");

check("origin 规范化", normalizeOrigin("https://x.test/") === "https://x.test");

// 错误分类：决定「要不要重试」，错判会直接变成用户看到的失败
const kindOf = (status, body) =>
  new UpstreamError({ status, kind: classify(status, "invalid_request_error", body), message: "x" });
check("车道 426", classify(426, "", "") === "lane");
check("鉴权 401", classify(401, "", "") === "auth");
check("繁忙 429", classify(429, "", "") === "busy");
const rejected = kindOf(400, '{"error":{"message":"This request cannot be accepted."}}');
check("形状拒绝不可重试", rejected.kind === "body" && rejected.retryable === false, rejected.kind);
const providerDown = kindOf(400, '{"error":{"message":"The model provider rejected this request."}}');
check("provider 拒收可重试", providerDown.kind === "provider" && providerDown.retryable === true, providerDown.kind);
check("鉴权错误不可重试", new UpstreamError({ status: 401, kind: "auth", message: "x" }).retryable === false);

console.log("\n== 2. 存储 ==");
const dataDir = process.env.DEEPAI_DATA_DIR ?? defaultDataDir();
console.log(`  dataDir = ${dataDir}`);
if (await adoptLegacyData(dataDir)) console.log("  已接管旧目录凭据");
const store = new PluginStore(dataDir);
const account = await store.account();
check("读到账号", account !== null, account?.username ?? "(none)");

console.log("\n== 3. 上游 ==");
const upstream = new Upstream({ store, origin: normalizeOrigin(process.env.DEEPAI_API_ORIGIN), log });
await upstream.boot();
console.log(`  缓存目录 ${upstream.models().length} 项, 车道 ${upstream.lane ?? "(未定)"}`);

if (account !== null) {
  const lane = await upstream.ensureLane(true).catch((error) => {
    console.error(`  车道失败: ${error.message}`);
    return "";
  });
  check("车道握手", lane !== "", `lane ${lane}`);

  const models = await upstream.refreshModels({ force: true });
  check("模型目录", models.ok === true, models.ok ? `${models.count} 个` : models.error);
  check("目录非空", upstream.models().length > 0, `${upstream.models().length} 项`);
} else {
  console.log("  跳过在线检查：没有登录凭据");
}

const adapter = new DeepAIAdapter({ providerId: "deepai", displayName: "DeepAI Code", upstream, store });
const listed = adapter.listModels("deepai");
check("listModels 非空", listed.length > 0, `${listed.length} 项`);
if (listed.length > 0) {
  const resolved = adapter.resolveModel("deepai", listed[0].id);
  check("resolveModel 上下文", resolved.context.contextWindow > 0, String(resolved.context.contextWindow));
  check("resolveModel maxTokens", resolved.defaultMaxTokens > 0, String(resolved.defaultMaxTokens));
  if (resolved.reasoning !== undefined) {
    check("reasoning efforts", resolved.reasoning.efforts.length > 0, resolved.reasoning.efforts.map((e) => e.id).join(","));
  }
}

console.log("\n== 4. 端到端自检 ==");
if (account !== null) {
  const report = await upstream.selftest({ probeChat: process.env.SKIP_CHAT !== "1" });
  for (const step of report.steps) {
    console.log(`  ${step.ok ? "ok  " : "FAIL"} ${step.label} (${step.ms}ms) ${step.detail}`);
    if (step.hint) console.log(`       hint: ${step.hint}`);
    if (step.ok !== true) failures += 1;
  }
  const snap = report.snapshot;
  console.log(`  lane=${snap.lane} machine=${snap.machineReady} catalog=${snap.catalogSource}/${snap.catalogCount}`);
} else {
  console.log("  跳过：没有登录凭据");
}

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
