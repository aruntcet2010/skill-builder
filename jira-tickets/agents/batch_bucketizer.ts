import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";
import { formatTicketDump, type FullTicket, type IssueTypeBucket } from "./types.js";

function buildPrompt(tickets: FullTicket[]): string {
  return `You are analyzing Hevo Data oncall tickets to classify them from the customer's perspective.

Read each ticket fully — description and comments reveal the real root cause.

${formatTicketDump(tickets)}

Return ONLY a JSON array with no markdown or explanation:
[
  {
    "issue_type": "<what the customer experienced, e.g. 'Data not appearing in destination', 'Pipeline stopped ingesting'>",
    "causes_with_tickets": [
      { "cause": "<technical root cause>", "ticket_ids": ["HEVO-xxx", ...] }
    ]
  }
]

Rules:
- issue_type must be written from the customer's point of view — what they observed or complained about
- Group tickets purely by customer-facing symptom; different root causes within the same symptom are fine
- Within causes_with_tickets, group tickets that share the exact same root cause under one entry; tickets with distinct causes get their own entry
- cause must be derived from the full ticket content, not just the summary
- Every ticket key must appear in exactly one causes_with_tickets entry`;
}

export async function runBatchBucketizer(
  tickets: FullTicket[],
  batchIdx: number,
  totalBatches: number,
  batchFile: string,
  env: Record<string, string>,
): Promise<IssueTypeBucket[]> {
  const prompt = buildPrompt(tickets);

  let resultText = "";
  for await (const msg of query({ prompt, options: { env } })) {
    if (msg.type === "result" && msg.subtype === "success") {
      resultText = msg.result;
    }
  }

  const jsonMatch = resultText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    process.stderr.write(`Batch ${batchIdx}: could not parse agent response\n`);
    return tickets.map((t) => ({
      issue_type: "Uncategorized",
      causes_with_tickets: [{ cause: "Unknown", ticket_ids: [t.key] }],
    }));
  }

  const buckets = JSON.parse(jsonMatch[0]) as IssueTypeBucket[];

  fs.mkdirSync(path.dirname(batchFile), { recursive: true });
  fs.writeFileSync(batchFile, JSON.stringify(buckets, null, 2), "utf-8");
  process.stderr.write(`  Batch ${batchIdx}/${totalBatches}: written to ${batchFile}\n`);

  return buckets;
}
