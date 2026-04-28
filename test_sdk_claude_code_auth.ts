/**
 * Quick test: does the Claude Agent SDK work with Claude Code credentials (no API key)?
 * TypeScript equivalent of test_sdk_claude_code_auth.py
 */

import {
  query,
  type SDKMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

async function main(): Promise<void> {
  delete process.env.ANTHROPIC_API_KEY;
  console.log(`ANTHROPIC_API_KEY set? ${"ANTHROPIC_API_KEY" in process.env}`);

  const answerParts: string[] = [];

  for await (const message of query({
    prompt: "What is 1 + 2? Answer with just the number.",
    options: {
      model: "claude-sonnet-4-6",
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user"],
      allowedTools: [],
      permissionMode: "bypassPermissions",
    },
  })) {
    const msg = message as SDKMessage;

    if (msg.type === "assistant") {
      const assistantMsg = msg as SDKAssistantMessage;
      for (const block of assistantMsg.message.content) {
        if (block.type === "text") {
          answerParts.push(block.text);
        }
      }
    } else if (msg.type === "result") {
      const resultMsg = msg as SDKResultMessage;
      const models = Object.keys(resultMsg.modelUsage ?? {}).join(", ") || "unknown";
      console.log(
        `--- done: success=${!resultMsg.is_error}, ` +
          `duration=${resultMsg.duration_ms}ms, ` +
          `cost=$${resultMsg.total_cost_usd}, ` +
          `models used=${models} ---`
      );
    }
  }

  const answer = answerParts.join("").trim() || "<empty>";
  console.log("Answer:", answer);
}

main().catch(console.error);
