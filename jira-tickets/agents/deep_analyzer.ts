import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";
import { formatTicketDump, type FullTicket, type IssueTypeBucket } from "./types.js";

function buildPrompt(bucket: IssueTypeBucket, tickets: FullTicket[]): string {
  const allTicketIds = bucket.causes_with_tickets.flatMap((c) => c.ticket_ids);
  const causesSummary = bucket.causes_with_tickets
    .map((c) => `- Cause: "${c.cause}" → Tickets: ${c.ticket_ids.join(", ")}`)
    .join("\n");

  return `You are a Hevo Data oncall analyst doing a deep analysis of a specific issue type.

Issue Type: "${bucket.issue_type}"

Pre-classified causes and their tickets:
${causesSummary}

Full ticket content for all ${allTicketIds.length} tickets in this issue type:

${formatTicketDump(tickets)}

Produce a detailed analysis as a single JSON object with no markdown or explanation:

{
  "issue_type": "<exact issue type name>",
  "symptoms": ["<specific symptom observed by customers>", ...],
  "causes": [
    {
      "cause": "<technical root cause>",
      "ticket_ids": ["HEVO-xxx", ...],
      "explanation": "<detailed explanation of why this cause leads to the issue, what conditions trigger it, and how to identify it from ticket content>"
    }
  ],
  "all_ticket_ids": ["HEVO-xxx", ...],
  "patterns": "<recurring themes, configurations, or conditions observed across all tickets in this issue type>"
}

Rules:
- symptoms: what customers specifically complained about or observed (from descriptions and comments), not internal causes
- causes[].explanation: go deep — explain the technical mechanism, trigger conditions, and how an oncall agent recognizes this from ticket content
- patterns: highlight recurring themes such as specific versions, customer setups, or time-based trends
- all_ticket_ids must include every ticket ID in this issue type exactly once
- Do not invent information not present in the tickets`;
}

export async function runDeepAnalyzer(
  bucket: IssueTypeBucket,
  tickets: FullTicket[],
  outPath: string,
  env: Record<string, string>,
): Promise<void> {
  const allTicketIds = bucket.causes_with_tickets.flatMap((c) => c.ticket_ids);
  process.stderr.write(`  Analyzing: "${bucket.issue_type}" (${allTicketIds.length} tickets)...\n`);

  const prompt = buildPrompt(bucket, tickets);

  let resultText = "";
  for await (const msg of query({ prompt, options: { env } })) {
    if (msg.type === "result" && msg.subtype === "success") {
      resultText = msg.result;
    }
  }

  const jsonMatch = resultText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    process.stderr.write(`  Could not parse agent response for issue type "${bucket.issue_type}"\n`);
    return;
  }

  const analysis = JSON.parse(jsonMatch[0]);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(analysis, null, 2), "utf-8");
  process.stderr.write(`  Written: ${outPath}\n`);
}
