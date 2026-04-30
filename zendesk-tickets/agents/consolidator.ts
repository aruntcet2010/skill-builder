import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs/promises";
import type { Symptom } from "./types.js";

function buildPrompt(connector: string, batchFilePaths: string[], outputPath: string): string {
  return `You are a support ticket analyst consolidating symptom data for the "${connector}" connector.

Read each of the following batch JSON files using the Read tool. Each file contains a JSON array of customer-visible symptoms extracted from a batch of support tickets.

Batch files:
${batchFilePaths.join("\n")}

Then:
1. Deduplicate: if two entries describe the same customer-visible symptom (even if worded differently), merge them — combine ticket_ids, keep highest severity, write a unified description
2. Drop any symptom with fewer than 3 ticket_ids after merging
3. Sort by total ticket_ids count descending (most frequent symptom first)
4. Take the top 20 symptoms
5. Assign each a unique slug: 3-4 word kebab-case describing the customer symptom (e.g. "binlog-not-syncing", "oauth-token-expired", "pipeline-stuck-ingesting")
6. Extract 3-5 keywords per symptom: actual error messages or phrases a customer would search for (from the descriptions)

Write the final JSON array to: ${outputPath}

Each entry in the output JSON must have these fields:
- slug: string (unique kebab-case, 3-4 words)
- title: string
- severity: "critical" | "high" | "medium" | "low"
- description: string
- ticket_ids: string array
- keywords: string array (actual error messages or search phrases from ticket content)

Write ONLY the JSON array to the file — no markdown, no explanation, no code fences.`;
}

export async function runConsolidator(
  connector: string,
  batchFilePaths: string[],
  outputPath: string,
  env: Record<string, string>,
): Promise<Symptom[]> {
  const prompt = buildPrompt(connector, batchFilePaths, outputPath);

  const rawStream = query({
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
  });

  for await (const message of rawStream) {
    const msg = message as SDKMessage;
    if (msg.type === "result" && (msg as SDKResultMessage).is_error) {
      throw new Error(`consolidator failed for ${connector}`);
    }
  }

  const content = await fs.readFile(outputPath, "utf8");
  return JSON.parse(content) as Symptom[];
}
