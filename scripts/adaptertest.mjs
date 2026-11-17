/**
 * 开发期适配器自检：完全按 DSH 的调用方式走一遍
 * `prepareCall` → `stream()`，含工具调用，验证 chunk 序列。
 *
 *   node scripts/adaptertest.mjs
 */

import process from "node:process";
import { PluginStore, adoptLegacyData, defaultDataDir } from "../lib/store.js";
import { Upstream } from "../lib/upstream.js";
import { DeepAIAdapter } from "../lib/adapter.js";
import { normalizeOrigin } from "../lib/protocol.js";

const log = { info: console.log, warn: console.warn, error: console.error };
const dataDir = process.env.DEEPAI_DATA_DIR ?? defaultDataDir();
if (await adoptLegacyData(dataDir)) console.log("已接管旧目录凭据");
const store = new PluginStore(dataDir);
const upstream = new Upstream({ store, origin: normalizeOrigin(process.env.DEEPAI_API_ORIGIN), log });
await upstream.boot();
await upstream.refreshModels();

const adapter = new DeepAIAdapter({ providerId: "deepai", displayName: "DeepAI Code", upstream, store });
const modelId = process.argv[2] ?? "glm-5.3-flash";

const info = adapter.providerInfo("deepai");
console.log(`providerInfo: ${JSON.stringify(info)}`);
console.log(`retryPolicy: ${JSON.stringify(adapter.providerRetryPolicy("deepai"))}`);

const controller = new AbortController();
const started = Date.now();
const call = await adapter.prepareCall("deepai", modelId, controller.signal);
console.log(`prepareCall ${Date.now() - started}ms -> context=${call.model.context.contextWindow} max=${call.model.defaultMaxTokens}`);
console.log(`reasoning: ${JSON.stringify(call.model.reasoning?.efforts?.map((e) => e.id))}`);

const counts = {};
let text = "";
let toolArgs = "";
let toolName = "";
let finish = null;
let firstAt = 0;

for await (const chunk of call.stream({
  messages: [{ role: "user", content: [{ type: "text", text: "现在东京几点？请调用 get_time 工具，时区传 Asia/Tokyo。" }] }],
  system: "You are a helpful assistant. Use tools when needed.",
  tools: [
    {
      name: "get_time",
      description: "Get the current time in a timezone",
      parameters: {
        type: "object",
        properties: { timezone: { type: "string", description: "IANA timezone" } },
        required: ["timezone"]
      }
    }
  ],
  maxTokens: 512,
  signal: controller.signal
})) {
  counts[chunk.type] = (counts[chunk.type] ?? 0) + 1;
  if (firstAt === 0 && (chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta")) {
    firstAt = Date.now() - started;
  }
  if (chunk.type === "text-delta") text += chunk.text;
  else if (chunk.type === "tool-call-delta") {
    if (chunk.name !== undefined) toolName = chunk.name;
    toolArgs += chunk.argumentsDelta;
  } else if (chunk.type === "block-end" && chunk.block?.type === "tool-call") {
    toolName = chunk.block.name || toolName;
    toolArgs = chunk.block.arguments || toolArgs;
  } else if (chunk.type === "finish") {
    finish = chunk.reason;
  }
}

console.log(`chunk types: ${JSON.stringify(counts)}`);
console.log(`first token at ${firstAt}ms, total ${Date.now() - started}ms`);
console.log(`text: ${text.slice(0, 120)}`);
console.log(`tool: ${toolName} ${toolArgs}`);
console.log(`finish: ${JSON.stringify(finish)}`);

const ok = finish?.kind !== "error" && (text.trim() !== "" || toolName !== "");
console.log(ok ? "\n适配器链路正常" : "\n适配器链路有问题");
process.exit(ok ? 0 : 1);
