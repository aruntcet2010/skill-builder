import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";
import type { IssueTypeBucket } from "./types.js";

function buildPrompt(allBatches: { batch: number; buckets: IssueTypeBucket[] }[]): string {
  const batchDump = allBatches.map(({ batch, buckets }) =>
    `=== Batch ${batch} ===\n${JSON.stringify(buckets, null, 2)}`
  ).join("\n\n");

  return `You are merging issue-type buckets produced by multiple independent agents that analyzed batches of Hevo Data support tickets.

Each agent classified tickets from the customer's point of view. Because agents worked on separate batches, the same customer symptom may appear under slightly different names across batches.

Here are all the batch results:

${batchDump}

Your task: produce a single merged JSON array in exactly the same format as the input, with no markdown or explanation.

Format:
[
  {
    "issue_type": "<customer-facing symptom>",
    "causes_with_tickets": [
      { "cause": "<technical root cause>", "ticket_ids": ["HEVO-xxx", ...] }
    ]
  }
]

Rules:
- Merge issue_type entries that describe the same customer-facing symptom, even if worded differently
- Within a merged issue_type, keep causes_with_tickets entries separate if root causes differ; merge them only if they are truly the same cause
- Every ticket ID that appears in the input must appear exactly once in the output
- Sort by total ticket count descending`;
}

export async function runMerger(batchFiles: string[], outputFile: string): Promise<IssueTypeBucket[]> {
  const allBatches = batchFiles.map((f, i) => ({
    batch: i + 1,
    buckets: JSON.parse(fs.readFileSync(f, "utf-8")) as IssueTypeBucket[],
  }));

  process.stderr.write("\nRunning merge agent across all batches...\n");

  const prompt = buildPrompt(allBatches);

  let resultText = "";
  for await (const msg of query({ prompt })) {
    if (msg.type === "result" && msg.subtype === "success") {
      resultText = msg.result;
    }
  }

  const jsonMatch = resultText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Merge agent could not produce valid JSON");
  }

  const merged = JSON.parse(jsonMatch[0]) as IssueTypeBucket[];
  const absPath = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(merged, null, 2), "utf-8");

  const total = merged.reduce((s, b) => s + b.causes_with_tickets.reduce((ss, c) => ss + c.ticket_ids.length, 0), 0);
  process.stderr.write(`Merge complete: ${merged.length} issue types, ${total} tickets. Written to ${absPath}\n`);

  return merged;
}
