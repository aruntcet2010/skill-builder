import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import type { IssueTypeBucket } from "./types.js";

function buildPrompt(batchFilePaths: string[], outputJsonPath: string): string {
  return `You are merging issue-type buckets produced by multiple independent agents that analyzed batches of Hevo Data oncall tickets.

Each batch agent classified tickets from the customer's point of view. Because agents worked on separate batches, the same customer symptom may appear under slightly different names across batches.

Read each of the following batch JSON files using the Read tool:
${batchFilePaths.join("\n")}

Then write a single merged JSON array to this output file using the Write tool:
${outputJsonPath}

The output JSON must be exactly this shape — no markdown, no code fences, no commentary:
[
  {
    "issue_type": "<customer-facing symptom>",
    "causes_with_tickets": [
      { "cause": "<technical root cause>", "ticket_ids": ["HEVO-xxx", ...] }
    ]
  }
]

Rules:
- Read EVERY batch file before merging
- Merge issue_type entries that describe the same customer-facing symptom, even if worded differently
- Within a merged issue_type, keep causes_with_tickets entries separate if root causes differ; merge them only if they are truly the same cause
- Every ticket ID that appears in the input must appear exactly once in the output
- Sort by total ticket count descending
- Write the JSON to the file — do not return it as text`;
}

export async function runDeduplicator(
  batchFilePaths: string[],
  outputJsonPath: string,
  env: Record<string, string>,
): Promise<IssueTypeBucket[]> {
  process.stderr.write("\nRunning deduplicator agent across all batches...\n");

  const prompt = buildPrompt(batchFilePaths, outputJsonPath);

  for await (const message of query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      tools: ["Read", "Write"],
      permissionMode: "bypassPermissions",
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 30,
      env,
    },
  })) {
    const msg = message as SDKMessage;
    if (msg.type === "result" && (msg as SDKResultMessage).is_error) {
      throw new Error(`deduplicator failed for ${outputJsonPath}`);
    }
  }

  if (!fs.existsSync(outputJsonPath)) {
    throw new Error(`deduplicator did not write ${outputJsonPath}`);
  }
  const merged = JSON.parse(fs.readFileSync(outputJsonPath, "utf-8")) as IssueTypeBucket[];
  const total = merged.reduce(
    (s, b) => s + b.causes_with_tickets.reduce((ss, c) => ss + c.ticket_ids.length, 0),
    0,
  );
  process.stderr.write(`Dedup complete: ${merged.length} issue types, ${total} tickets. Written to ${outputJsonPath}\n`);
  return merged;
}
