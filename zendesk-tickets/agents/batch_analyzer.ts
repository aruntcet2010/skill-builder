import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs/promises";
import type { SymptomSummary } from "./types.js";

function buildPrompt(ticketPaths: string[], outputPath: string): string {
  return `You are a support ticket analyst.

Read each of the following ticket files using the Read tool, then identify every distinct customer-visible symptom across all the tickets.

Ticket files:
${ticketPaths.join("\n")}

For each distinct symptom group return a JSON object with these fields:
- title: concise symptom title from the customer's perspective (max 15 words, e.g. "Binlog Not Syncing", "OAuth Token Keeps Expiring")
- severity: "critical" | "high" | "medium" | "low" (highest seen across related tickets)
- description: one sentence describing what the customer sees (based only on ticket content)
- ticket_ids: string array of ALL ticket IDs in this symptom group

Write the final JSON array to: ${outputPath}

Rules:
- Read ALL ticket files before extracting symptoms
- Read the output file path before writing to it (even if it does not exist yet — that is fine)
- Group by customer-visible symptom — same symptom, different root cause = same group
- One ticket can only belong to one symptom group (pick the best match)
- Write ONLY a valid JSON array to the file — no markdown, no explanation, no code fences
- If a ticket has no useful signal (e.g. spam, test ticket), skip it`;
}

export async function runBatchAnalyzer(
  ticketPaths: string[],
  outputPath: string,
  env: Record<string, string>,
): Promise<SymptomSummary[]> {
  const prompt = buildPrompt(ticketPaths, outputPath);

  const rawStream = query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      tools: ["Read", "Write"],
      permissionMode: "bypassPermissions",
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 20,
      env,
    },
  });

  for await (const message of rawStream) {
    const msg = message as SDKMessage;
    if (msg.type === "result" && (msg as SDKResultMessage).is_error) {
      throw new Error(`batch_analyzer failed for ${outputPath}`);
    }
  }

  const content = await fs.readFile(outputPath, "utf8");
  return JSON.parse(content) as SymptomSummary[];
}
