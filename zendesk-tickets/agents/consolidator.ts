import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs/promises";
import type { Symptom } from "./types.js";

function buildPrompt(connector: string, batchFilePaths: string[], outputPath: string): string {
  return `You are a support ticket analyst consolidating problem data for the "${connector}" area.

Read each of the following batch JSON files using the Read tool. Each file contains a JSON array of customer-visible problems extracted from a batch of support tickets.

Batch files:
${batchFilePaths.join("\n")}

Then:
1. Deduplicate: if two entries describe the same customer-visible problem (even if worded differently), merge them — combine ticket_ids, write a unified description. Do NOT merge problems that occur at different stages (e.g. "object not found during setup" vs "object is configured but data is missing in destination" are separate problems)
2. Drop any problem with fewer than 2 ticket_ids after merging
3. Sort by total ticket_ids count descending (most frequent first)
4. Take the top 20
5. Assign each a unique slug: 3-4 word kebab-case describing the customer problem (e.g. "records-missing-destination", "pipeline-stuck-loading", "source-object-unavailable", "destination-column-limit-exceeded")

Write the final JSON array to: ${outputPath}

Each entry must have these fields:
- slug: string (unique kebab-case, 3-4 words)
- title: string
- description: string — describe the problem pattern generically; do not include customer names, company names, account IDs, or pipeline numbers
- root_causes: string array (pass through from the batch input; if merging multiple entries, combine their root_causes arrays and deduplicate — same cause worded differently should be kept as one entry; refer to the product as "the platform" or "the connector", never a brand name)
- summary: string (max 15 words — the single most distinctive customer-visible signal, written so the reader can instantly decide if this matches their customer's complaint, e.g. "Source object entirely absent from setup selector despite valid source connection" or "Destination records contain only ID; all property columns null after merge")
- ticket_ids: string array

Example of a well-formed entry:
{
  "slug": "destination-column-limit-exceeded",
  "title": "Pipeline Fails to Load — Destination Column Limit Exceeded",
  "description": "In the pipeline status page, load events for the <object_type> object fail and accumulate as errored records. The error message reads: \\"Destination doesn't allow more than 4090 columns in a table.\\" The issue persists even after the customer drops and recreates the destination table.",
  "root_causes": [
    "The destination enforces a hard column limit per table; when the source schema exceeds this threshold all load events for that object fail.",
    "Unconfirmed: Previously deleted source fields may still be exposed in the schema, artificially inflating the column count."
  ],
  "summary": "Load events fail with column limit error; persist after destination table recreation",
  "ticket_ids": ["12345", "12346", "12347"]
}

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
      maxTurns: 50,
      maxThinkingTokens: 64000,
      env,
    },
  });

  for await (const message of rawStream) {
    const msg = message as SDKMessage;
    if (msg.type === "result" && (msg as SDKResultMessage).is_error) {
      // Agent may have written the file before exhausting turns — use it if valid
      try {
        const content = await fs.readFile(outputPath, "utf8");
        const result = JSON.parse(content) as Symptom[];
        if (result.length > 0) return result;
      } catch { /* fall through */ }
      throw new Error(`consolidator failed for ${connector}`);
    }
  }

  const content = await fs.readFile(outputPath, "utf8");
  return JSON.parse(content) as Symptom[];
}
