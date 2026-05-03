import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs/promises";
import type { Symptom } from "./types.js";

function buildPrompt(connector: string, batchFilePaths: string[], outputPath: string): string {
  return `You are a support ticket analyst consolidating symptom data for the "${connector}" connector.

Read each of the following batch JSON files using the Read tool. Each file contains a JSON array of customer-visible symptoms extracted from a batch of support tickets.

Batch files:
${batchFilePaths.join("\n")}

Then:
1. Deduplicate: if two entries describe the same customer-visible symptom (even if worded differently), merge them — combine ticket_ids, write a unified description. Do NOT merge symptoms that occur at different surfaces or stages of the customer journey (e.g. "can't find object during pipeline setup" vs "object is configured but data is missing in destination" are separate symptoms)
2. Drop any symptom with fewer than 2 ticket_ids after merging
3. Sort by total ticket_ids count descending (most frequent symptom first)
4. Take the top 20 symptoms
5. Assign each a unique slug: 3-4 word kebab-case describing the customer symptom (e.g. "binlog-not-syncing", "oauth-token-expired", "pipeline-stuck-ingesting")
6. Extract 3-5 keywords per symptom. Keywords must be verbatim strings a customer would type when searching — exact error messages copied from the description, specific object names, table names, or field names. Do NOT use generic phrases like "ingestion failures", "data missing", or "pipeline error" — these match too broadly and are useless for routing.

Write the final JSON array to: ${outputPath}

Each entry in the output JSON must have these fields:
- slug: string (unique kebab-case, 3-4 words)
- title: string
- description: string
- root_cause: string (pass through from the batch input; if merging multiple entries, concatenate their root_causes separated by " / " and deduplicate)
- summary: string (max 15 words — the single most distinctive customer-visible signal; written so Claude can instantly decide if this issue matches the customer's complaint, e.g. "Events Ingested count far exceeds records loaded; association objects draining quota" or "Ingestion fails with 4090 column limit error on BigQuery")
- ticket_ids: string array
- keywords: string array (verbatim error messages and specific names from ticket content — no generic phrases)

Read the output file path before writing to it (even if it does not exist yet — that is fine).

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
