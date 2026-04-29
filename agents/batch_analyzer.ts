import { query, type SDKMessage, type SDKAssistantMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SymptomSummary } from "./types.js";

function buildPrompt(ticketPaths: string[]): string {
  return `You are a support ticket analyst.

Read each of the following ticket files using the Read tool, then identify every distinct customer-visible symptom across all the tickets.

Ticket files:
${ticketPaths.join("\n")}

For each distinct symptom group return a JSON object with these fields:
- title: concise symptom title from the customer's perspective (max 15 words, e.g. "Binlog Not Syncing", "OAuth Token Keeps Expiring")
- severity: "critical" | "high" | "medium" | "low" (highest seen across related tickets)
- description: one sentence describing what the customer sees (based only on ticket content)
- ticket_ids: string array of ALL ticket IDs in this symptom group

Rules:
- Read ALL files before extracting symptoms
- Group by customer-visible symptom — same symptom, different root cause = same group
- One ticket can only belong to one symptom group (pick the best match)
- Return ONLY a valid JSON array — no markdown, no explanation, no code fences
- If a ticket has no useful signal (e.g. spam, test ticket), skip it`;
}

export async function runBatchAnalyzer(
  ticketPaths: string[],
  env: Record<string, string>,
): Promise<SymptomSummary[]> {
  let output = "";

  for await (const message of query({
    prompt: buildPrompt(ticketPaths),
    options: {
      model: "claude-sonnet-4-6",
      allowedTools: ["Read"],
      permissionMode: "acceptEdits",
      settingSources: ["user"],
      maxTurns: 20,
      env,
    },
  })) {
    const msg = message as SDKMessage;
    if (msg.type === "assistant") {
      for (const block of (msg as SDKAssistantMessage).message.content) {
        if (block.type === "text") output += block.text;
      }
    } else if (msg.type === "result") {
      if ((msg as SDKResultMessage).is_error) {
        throw new Error(`batch_analyzer failed: ${output.slice(0, 200)}`);
      }
    }
  }

  const match = output.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`batch_analyzer returned no JSON:\n${output.slice(0, 300)}`);
  return JSON.parse(match[0]) as SymptomSummary[];
}
