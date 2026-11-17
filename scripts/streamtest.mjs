/**
 * 开发期流式自检：打印 chunk 序列，确认 SSE → DSH 片段的映射正确。
 *
 *   node scripts/streamtest.mjs [modelId]
 */

import process from "node:process";
import { PluginStore, adoptLegacyData, defaultDataDir } from "../lib/store.js";
import { Upstream } from "../lib/upstream.js";
import { normalizeOrigin, buildChatBody, toStreamChunks } from "../lib/protocol.js";

const log = { info: console.log, warn: console.warn, error: console.error };
const dataDir = process.env.DEEPAI_DATA_DIR ?? defaultDataDir();
if (await adoptLegacyData(dataDir)) console.log("已接管旧目录凭据");
const store = new PluginStore(dataDir);
const upstream = new Upstream({ store, origin: normalizeOrigin(process.env.DEEPAI_API_ORIGIN), log });
await upstream.boot();
await upstream.refreshModels();

const modelId = process.argv[2] ?? upstream.models()[0]?.id;
console.log(`model = ${modelId}`);

const body = buildChatBody(
  {
    messages: [
      { role: "system", content: "You are a concise assistant." },
      { role: "user", content: [{ type: "text", text: "用一句话介绍你自己，然后说三个字：你好呀。" }] }
    ],
    maxTokens: 300
  },
  modelId
);

const started = Date.now();
let stream;
try {
  stream = await upstream.chat({ body, systemPrompt: "You are a concise assistant." });
} catch (error) {
  // 上游拒绝时给出分类，而不是甩一段堆栈
  console.error(
    `请求失败：kind=${error.kind ?? "-"} status=${error.status ?? "-"} code=${error.code ?? "-"}`
  );
  console.error(error.message);
  process.exit(1);
}
console.log(`headers in ${Date.now() - started}ms`);

const counts = {};
let text = "";
let reasoning = "";
let finish = null;
let firstAt = 0;
for await (const chunk of toStreamChunks(stream, modelId)) {
  counts[chunk.type] = (counts[chunk.type] ?? 0) + 1;
  if (chunk.type === "text-delta") {
    if (firstAt === 0) firstAt = Date.now() - started;
    text += chunk.text;
  } else if (chunk.type === "reasoning-delta") {
    reasoning += chunk.text;
  } else if (chunk.type === "finish") {
    finish = chunk.reason;
  }
}

console.log("chunk types:", JSON.stringify(counts));
console.log(`first token at ${firstAt}ms, total ${Date.now() - started}ms`);
console.log(`reasoning(${reasoning.length}): ${reasoning.slice(0, 80)}`);
console.log(`text(${text.length}): ${text}`);
console.log(`finish: ${JSON.stringify(finish)}`);

const ok = counts["text-delta"] > 0 && text.trim() !== "" && finish?.kind !== "error";
console.log(ok ? "\n流式链路正常" : "\n流式链路有问题");
process.exit(ok ? 0 : 1);
