/**
 * 离线协议自检：JSON 文本归一化 + auto-review 流式输出。
 *
 *   node scripts/protocoltest.mjs
 *
 * 不联网、不需要凭据，专门覆盖「Auto review ... Unexpected token」那类失败。
 */

import {
  buildChatBody,
  isJsonObjectText,
  isReviewDecisionText,
  repairAutoReviewDecision,
  retryAfterSeconds,
  sanitizeJsonText,
  toOpenAIMessages,
  toStreamChunks
} from "../lib/protocol.js";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("== sanitizeJsonText ==");
const plain = '{"risk":"low","decision":"allow"}';

check("合法 JSON 原样返回", sanitizeJsonText(plain) === plain);
check("Markdown 围栏", isJsonObjectText(sanitizeJsonText(`\`\`\`json\n${plain}\n\`\`\``)));
check(
  "前言与尾注",
  sanitizeJsonText(`审查结果如下：\n{"risk":"high","decision":"deny"}\n以上。`) ===
    '{"risk":"high","decision":"deny"}'
);
check("BOM 与零宽字符", isJsonObjectText(sanitizeJsonText(`\uFEFF\u200B${plain}`)));
check("尾逗号修复", isJsonObjectText(sanitizeJsonText('{"risk":"low","decision":"allow",}')));
check(
  "多个对象时优先取 decision",
  sanitizeJsonText('例子：{"a":1}\n最终：{"risk":"medium","decision":"allow"}') ===
    '{"risk":"medium","decision":"allow"}'
);
check("字符串里的花括号不打乱配平", isJsonObjectText(sanitizeJsonText('前言 {"decision":"deny","reason":"含 { 括号 }"}')));
check("没有 JSON 时返回原文", sanitizeJsonText("请求被拒绝") === "请求被拒绝");
check("数组不算对象", isJsonObjectText("[1,2]") === false);
check("空文本", sanitizeJsonText("   ") === "" && sanitizeJsonText(null) === "");

console.log("\n== toStreamChunks(jsonText) ==");

const encoder = new TextEncoder();
function frame(payload) {
  return encoder.encode(typeof payload === "string" ? payload : `data: ${JSON.stringify(payload)}\n\n`);
}
function streamOf(frames) {
  return new ReadableStream({
    start(controller) {
      for (const item of frames) controller.enqueue(frame(item));
      controller.close();
    }
  });
}
async function collect(stream, options) {
  const chunks = [];
  for await (const chunk of toStreamChunks(stream, "test-model", undefined, options)) chunks.push(chunk);
  return chunks;
}

const fenced = `\`\`\`json\n${plain}\n\`\`\``;
const reviewChunks = await collect(
  streamOf([
    { choices: [{ delta: { reasoning_content: "先核对一下参数。" } }] },
    { choices: [{ delta: { content: fenced } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "data: [DONE]\n\n"
  ]),
  { jsonText: true }
);
const textBlocks = reviewChunks
  .filter((chunk) => chunk.type === "block-end" && chunk.block.type === "text")
  .map((chunk) => chunk.block.text);
check("审查流只产出一个文本块", textBlocks.length === 1, JSON.stringify(textBlocks));
check("文本块可直接 JSON.parse", isJsonObjectText(textBlocks[0] ?? ""));
check("推理块保留在前", reviewChunks[0]?.type === "block-start" && reviewChunks[0]?.blockType === "reasoning");
check("finish 为 stop", reviewChunks.at(-1)?.type === "finish" && reviewChunks.at(-1).reason.kind === "stop");

const proseChunks = await collect(
  streamOf([
    { choices: [{ delta: { content: "决定：{\"risk\":\"medium\",\"decision\":\"deny\",\"reason\":\"删除生产数据\"}" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "data: [DONE]\n\n"
  ]),
  { jsonText: true }
);
const proseText = proseChunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "text")?.block.text;
check("前言包裹的 JSON 被抽出", isJsonObjectText(proseText ?? ""), proseText ?? "");

const reasoningOnly = await collect(
  streamOf([
    { choices: [{ delta: { reasoning_content: '思考后给出 {"risk":"low","decision":"allow"}' } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "data: [DONE]\n\n"
  ]),
  { jsonText: true }
);
const reasoningText = reasoningOnly.find((chunk) => chunk.type === "block-end" && chunk.block.type === "text")?.block.text;
check("正文为空时用推理块里的 JSON 兜底", isJsonObjectText(reasoningText ?? ""), reasoningText ?? "");

const normalChunks = await collect(
  streamOf([
    { choices: [{ delta: { content: "ab" } }] },
    { choices: [{ delta: { content: "cd" }, finish_reason: "stop" }] },
    "data: [DONE]\n\n"
  ])
);
const deltas = normalChunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text);
check("普通对话仍逐段流式输出", deltas.join("") === "abcd", deltas.join("|"));
check(
  "普通对话文本块内容不变",
  normalChunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "text")?.block.text === "abcd"
);

console.log("\n== auto-review 决策修复 ==");

const allowWithReason = repairAutoReviewDecision('{"risk":"low","decision":"allow","reason":"安全"}');
check("allow 多余的 reason 被丢弃", allowWithReason === '{"risk":"low","decision":"allow"}', allowWithReason);

const highAllow = repairAutoReviewDecision('{"risk":"high","decision":"allow"}');
check("high+allow 降级为拒绝", highAllow === '{"risk":"high","decision":"deny"}', highAllow);

const lowDeny = repairAutoReviewDecision('{"risk":"low","decision":"deny","reason":"x"}');
check("low+deny 保留拒绝", lowDeny === '{"risk":"medium","decision":"deny","reason":"x"}', lowDeny);

const upper = repairAutoReviewDecision('{"risk":"MEDIUM","decision":"ALLOW"}');
check("大小写归一", upper === '{"risk":"medium","decision":"allow"}', upper);

const synonym = repairAutoReviewDecision('{"risk":"medium","decision":"approve"}');
check("同义词归一", synonym === '{"risk":"medium","decision":"allow"}', synonym);

const chinese = repairAutoReviewDecision('{"risk":"高","decision":"拒绝","reason":"泄露"}');
check("中文枚举归一", chinese === '{"risk":"high","decision":"deny","reason":"泄露"}', chinese);

const capitalized = repairAutoReviewDecision('{"Risk":"Medium","Decision":"Deny"}');
check("大写键名归一", capitalized === '{"risk":"medium","decision":"deny"}', capitalized);

const singleQuoted = repairAutoReviewDecision(sanitizeJsonText("{'risk':'low','decision':'allow'}"));
check("单引号 JSON", singleQuoted === '{"risk":"low","decision":"allow"}', singleQuoted);

const proseZh = repairAutoReviewDecision("风险：中\n决定：拒绝\n理由：会删除生产数据");
check("中文散列写法", proseZh === '{"risk":"medium","decision":"deny"}', proseZh);

const proseEn = repairAutoReviewDecision("risk: low, decision: allow");
check("英文散列写法", proseEn === '{"risk":"low","decision":"allow"}', proseEn);

const proseNoise = repairAutoReviewDecision("当前 `426 up` 车道不可用，需要升级。");
check("无决策信息时不猜", isReviewDecisionText(proseNoise) === false);

const denyNoRisk = repairAutoReviewDecision('{"decision":"reject","reason":"no"}');
check("缺 risk 的拒绝仍可判", denyNoRisk === '{"risk":"medium","decision":"deny","reason":"no"}', denyNoRisk);

const allowNoRisk = repairAutoReviewDecision('{"decision":"allow"}');
check("缺 risk 的允许不猜", isReviewDecisionText(allowNoRisk) === false);

const validDeny = '{"risk":"high","decision":"deny","reason":"外传密钥"}';
check("合法拒绝保持", repairAutoReviewDecision(validDeny) === validDeny);
check("合法判定识别", isReviewDecisionText(validDeny));

const repairedStream = await collect(
  streamOf([
    { choices: [{ delta: { content: '```json\n{"risk":"low","decision":"allow","reason":"只读"}\n```' } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "data: [DONE]\n\n"
  ]),
  { jsonText: true }
);
const repairedText = repairedStream.find((chunk) => chunk.type === "block-end" && chunk.block.type === "text")?.block.text;
check("流式输出通过协议校验", isReviewDecisionText(repairedText ?? ""), repairedText ?? "");

console.log("\n== 工具调用流 ==");

const objectArgs = await collect(
  streamOf([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: { path: "a.txt" } } }]
          }
        }
      ]
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "data: [DONE]\n\n"
  ])
);
const objectCall = objectArgs.find((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call")?.block;
check("对象形态的参数被序列化", objectCall?.arguments === '{"path":"a.txt"}', objectCall?.arguments ?? "");
check("工具调用 finish", objectArgs.at(-1)?.reason?.kind === "tool-calls");

const noIndex = await collect(
  streamOf([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { id: "c1", function: { name: "read", arguments: '{"path":"a"}' } },
              { id: "c2", function: { name: "read", arguments: '{"path":"b"}' } }
            ]
          }
        }
      ]
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "data: [DONE]\n\n"
  ])
);
const noIndexCalls = noIndex.filter((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call");
check("缺 index 时按 id 分开", noIndexCalls.length === 2, `${noIndexCalls.length} 个`);
check(
  "缺 index 时参数不串台",
  noIndexCalls.map((chunk) => chunk.block.arguments).sort().join("|") === '{"path":"a"}|{"path":"b"}'
);

const emptyArgs = await collect(
  streamOf([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "list" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "data: [DONE]\n\n"
  ])
);
const emptyCall = emptyArgs.find((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call")?.block;
check("无参工具补 {}", emptyCall?.arguments === "{}", emptyCall?.arguments ?? "");

console.log("\n== 请求体构造 ==");

const converted = toOpenAIMessages([
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "先读文件" },
      { type: "text", text: "我来读一下" },
      { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a.txt"}' }
    ]
  },
  { role: "tool", toolCallId: "c1", content: [{ type: "image" }] },
  { role: "user", content: [{ type: "text", text: "继续" }] }
]);
check("历史不回传 reasoning_content", !("reasoning_content" in converted[0]));
check("工具调用保留", converted[0].tool_calls?.[0]?.function?.name === "read");
check("图片工具结果有占位", converted[1].content === "(image output omitted)");

const built = buildChatBody(
  {
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "sys",
    stop: ["END"],
    maxTokens: 64,
    temperature: 0.2,
    sessionId: "8f1d0c7a-1234-4abc-9def-0123456789ab",
    tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } }]
  },
  "m"
);
check("system 自动补齐", built.messages[0].role === "system" && built.messages[0].content === "sys");
check("stop 透传", Array.isArray(built.stop) && built.stop[0] === "END");
check("temperature 透传", built.temperature === 0.2);
check("max_completion_tokens", built.max_completion_tokens === 64);
check("prompt_cache_key 来自 sessionId", built.prompt_cache_key === "8f1d0c7a-1234-4abc-9def-0123456789ab");
check("工具 schema 包裹", built.tools?.[0]?.type === "function" && built.tools[0].function.name === "read");

const badSession = buildChatBody({ messages: [{ role: "user", content: [] }], sessionId: "bad id!" }, "m");
check("非法 sessionId 不发", !("prompt_cache_key" in badSession));

const developer = toOpenAIMessages([{ role: "developer", content: [{ type: "text", text: "x" }] }]);
check("developer 降级为 system", developer[0].role === "system");

check("Retry-After 数字", retryAfterSeconds("5") === 5);
check(
  "Retry-After 日期",
  retryAfterSeconds(new Date(Date.now() + 5_000).toUTCString()) >= 1
);
check("Retry-After 缺省", retryAfterSeconds(undefined) === 3);

console.log(`\n${failures === 0 ? "协议自检全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
