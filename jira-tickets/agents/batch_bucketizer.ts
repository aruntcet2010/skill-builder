import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import type { IssueTypeBucket } from "./types.js";

function buildPrompt(ticketFiles: string[], outputJsonPath: string): string {
  return `You are analyzing Hevo Data oncall tickets to classify them from the customer's perspective.

Read each of the following ticket markdown files using the Read tool. Each file contains the full ticket — title, metadata, description, and all comments — and reveals the real root cause.

Ticket files:
${ticketFiles.join("\n")}

Then write a JSON array to this output file using the Write tool:
${outputJsonPath}

The JSON must be exactly this shape, with no markdown, no code fences, no commentary:
[
  {
    "issue_type": "<what the customer experienced, e.g. 'Data not appearing in destination', 'Pipeline stopped ingesting'>",
    "causes_with_tickets": [
      { "cause": "<technical root cause>", "ticket_ids": ["HEVO-xxx", ...] }
    ]
  }
]

Rules:
- Read EVERY ticket file before extracting buckets
- issue_type must be written from the customer's point of view — what they observed or complained about
- Group tickets purely by customer-facing symptom; different root causes within the same symptom are fine
- Within causes_with_tickets, group tickets that share the exact same root cause under one entry; tickets with distinct causes get their own entry
- cause must be derived from the full ticket content, not just the summary
- Every ticket key must appear in exactly one causes_with_tickets entry
- Write the JSON array to the file — do not return it as text`;
}

export async function runBatchBucketizer(
  ticketFiles: string[],
  outputJsonPath: string,
  batchIdx: number,
  totalBatches: number,
  env: Record<string, string>,
): Promise<IssueTypeBucket[]> {
  process.stderr.write(`  Batch ${batchIdx}/${totalBatches}: bucketizing ${ticketFiles.length} tickets...\n`);

  const prompt = buildPrompt(ticketFiles, outputJsonPath);

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
      throw new Error(`batch_bucketizer ${batchIdx}/${totalBatches} failed`);
    }
  }

  if (!fs.existsSync(outputJsonPath)) {
    throw new Error(`batch_bucketizer ${batchIdx}/${totalBatches} did not write ${outputJsonPath}`);
  }
  const buckets = JSON.parse(fs.readFileSync(outputJsonPath, "utf-8")) as IssueTypeBucket[];
  process.stderr.write(`  Batch ${batchIdx}/${totalBatches}: written to ${outputJsonPath}\n`);
  return buckets;
}
