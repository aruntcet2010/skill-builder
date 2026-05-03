import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs/promises";
import type { SymptomSummary } from "./types.js";

function buildPrompt(ticketPaths: string[], outputPath: string): string {
  return `You are a support ticket analyst.

Read each of the following ticket files using the Read tool, then identify every distinct customer-visible problem across all the tickets.

Ticket files:
${ticketPaths.join("\n")}

For each distinct problem group, return a JSON object with these fields:

- title: concise problem title from the customer's perspective (max 10 words, e.g. "Records Missing from Destination After Sync", "Pipeline Stuck on Historical Load", "Source Object Not Available in Setup")

- description: 2-3 sentences describing the problem pattern. Must include:
  (1) where in the product the customer notices the problem (e.g. "in the pipeline status page", "in the source object selector", "in the destination table", "during pipeline setup")
  (2) the exact error message verbatim if one appears in the tickets
  (3) the specific object, table, or field names involved, using placeholders like <object_type> or <field_name> for values that vary across tickets
  Describe the pattern — do not include customer names, company names, account IDs, or pipeline numbers.

- root_causes: string array — one entry per distinct technical root cause found across the tickets in this group, based on investigation comments left by support staff. Each entry is 1-2 sentences explaining why the problem occurs. A cause explains a state or design constraint — not an action taken. If an entry contains verbs like "was deployed", "was fixed", "was enabled", "was changed", or "was configured", it is a resolution and must not be included here. Refer to the product as "the platform" or "the connector" — never use a brand name.
  A cause is CONFIRMED if a support staff member stated it directly as a fact in any comment or internal note (e.g. "we don't support X", "the issue is caused by Y", "this happens because Z") — even if the ticket's RCA field is marked unknown or the ticket was closed without resolution.
  A cause is UNCONFIRMED if: support staff used hedging words ("suspect", "likely", "may be", "could be", "possibly", "appears to"), OR no support staff member stated the cause at all (only a customer hypothesis, an automated RCA agent suggestion, or silence). Prefix with "Unconfirmed:" only in the second case.
  If no investigation is present write []

- ticket_ids: string array of ALL ticket IDs in this group

Example of a well-formed entry:
{
  "title": "Pipeline Fails to Load Data — Destination Column Limit Exceeded",
  "description": "In the pipeline status page, load events for the <object_type> object fail and accumulate as errored records. The error message reads: \\"Destination doesn't allow more than 4090 columns in a table. Please remove columns that are not required via transformations or ignore them in the schema mapper.\\" The issue surfaces only after the source schema grows beyond the destination's column ceiling, and persists even after the customer drops and recreates the destination table.",
  "root_causes": [
    "The destination enforces a hard column limit per table; when the source event type schema exceeds this threshold, all load events for that object fail immediately.",
    "Unconfirmed: Previously deleted source fields may still be exposed in the source schema, artificially inflating the column count past the limit."
  ],
  "ticket_ids": ["12345", "12346", "12347"]
}

Write the final JSON array to: ${outputPath}

Rules:
- Read ALL ticket files before extracting problems
- Group by customer-visible problem — same observable problem, different root cause = same group
- Keep groups separate if the problem occurs at different stages (e.g. "object not found during setup" is a different group from "object is configured but data is missing in destination")
- One ticket can only belong to one group — pick the group that best matches the customer's primary complaint
- Write ONLY a valid JSON array to the file — no markdown, no explanation, no code fences
- Skip tickets with no actionable problem: spam, test tickets, questions about expected behavior, or tickets where the customer only asks for information and no underlying issue is present`;
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
