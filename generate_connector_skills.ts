/**
 * Generate Claude Code skills from historical Zendesk tickets (last 6 months).
 * One skill per connector in cdk-patterns format.
 *
 * Usage:
 *   npx tsx generate_connector_skills.ts                          # all connectors
 *   npx tsx generate_connector_skills.ts --connector hubspot      # one connector
 *   npx tsx generate_connector_skills.ts --months 3               # last 3 months
 *   npx tsx generate_connector_skills.ts --preset                 # claude_code system prompt (default: minimal)
 */

import { query, type SDKMessage, type SDKAssistantMessage, type SDKResultMessage, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import path from "path";
import { fileURLToPath } from "url";

import fs from "fs/promises";
import { randomUUID } from "crypto";
import { RunTracer, type ToolDef } from "./tracer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const RUN_ID = randomUUID();
const SKILL_DIR = path.join(REPO_ROOT, "generated", RUN_ID, "connector-oncall");

// Process smallest connectors first for faster feedback
const ALL_CONNECTORS = [
  "hubspot",
  "zendesk",
  "oracle",
  "dynamodb",
  "shopify",
  "salesforce",
  "mssql",
  "mysql",
  "mongodb",
  "postgresql",
];

// ---------------------------------------------------------------------------
// Subagent 1 — lightweight batch analyzer (first pass: symptom identification only)
// ---------------------------------------------------------------------------
const TICKET_BATCH_ANALYZER: AgentDefinition = {
  description:
    "Reads a batch of Zendesk support ticket markdown files and returns a lightweight JSON array of customer-visible symptoms. " +
    "Used for the first pass only — identification and deduplication, not detailed analysis.",
  prompt: `You are a support ticket analyst. You will receive a list of ticket file paths.

Read each file using the Read tool, then identify every distinct customer-visible symptom across all the tickets.

For each distinct symptom group return a JSON object with these fields:
- title: concise symptom title from the customer's perspective (max 15 words, e.g. "Binlog Not Syncing", "OAuth Token Keeps Expiring")
- severity: "critical" | "high" | "medium" | "low" (use the highest seen across related tickets)
- description: one sentence describing what the customer sees (based only on ticket content)
- ticket_ids: string array of ALL ticket IDs in this symptom group

Rules:
- Read ALL files before extracting symptoms
- Group by customer-visible symptom — same symptom, different root cause = same group
- One ticket can only belong to one symptom group (pick the best match)
- Return ONLY a valid JSON array — no markdown, no explanation, no code fences
- If a ticket has no useful signal (e.g. spam, test ticket), skip it`,
  tools: ["Read"],
  model: "claude-sonnet-4-6",
};

// ---------------------------------------------------------------------------
// Subagent 2 — issue file writer (second pass: deep analysis per symptom)
// ---------------------------------------------------------------------------
const ISSUE_FILE_WRITER: AgentDefinition = {
  description:
    "Reads all Zendesk ticket files for a specific customer-visible symptom and writes a detailed issue markdown file. " +
    "Used in the second pass — one subagent per symptom, writing the final {slug}.md file.",
  prompt: `You are a support ticket analyst writing a detailed oncall issue file.

You will be given:
- A symptom title and output file path
- A list of ticket file paths that all relate to this symptom

Read every ticket file using the Read tool, then write a detailed issue file to the given output path using the Write tool.

The issue file must follow this exact format:

\`\`\`
# {title}

**Severity:** {highest severity seen} | **Tickets:** {total ticket count}

## What the Customer Sees
{2-3 sentences describing exactly what the customer experiences, using their own words and error messages from the tickets}

## Cause 1: {brief cause label}
**Root Cause:** {detailed technical root cause based on ticket content}

**Resolution:** {specific steps to fix or work around this cause, based on what worked in the tickets}

**Tickets:** {comma-separated ticket IDs for this cause}

## Cause 2: {brief cause label}
...repeat for each distinct root cause found across the tickets...

## All Related Tickets
{comma-separated ticket IDs across all causes}
\`\`\`

Rules:
- Read ALL ticket files before writing
- Extract exact error messages and keywords from the tickets — do not paraphrase
- Group tickets under the cause that best explains them
- If all tickets share the same root cause, write only one Cause section
- Write the file when done — do not return the content as text`,
  tools: ["Read", "Write"],
  model: "claude-sonnet-4-6",
};

// ---------------------------------------------------------------------------
// Main agent prompt
// ---------------------------------------------------------------------------
function buildPrompt(connector: string, months: number): string {
  const connectorDir = `${SKILL_DIR}/${connector}`;
  return `
You are generating oncall issue files for the "${connector}" connector from historical Zendesk support tickets.

Work through these steps in order:

## Step 1 — Fetch tickets
\`\`\`
npx tsx ${REPO_ROOT}/scripts/fetch_raw_tickets.ts --connector ${connector} --months ${months} --output /tmp/${connector}_tickets
\`\`\`
This writes one markdown file per ticket + metadata.md into /tmp/${connector}_tickets/.

## Step 2 — Read the metadata index
Read /tmp/${connector}_tickets/metadata.md to get the full list of ticket filenames and total count.
If 0 tickets, write ${connectorDir}/selection.md with a single line: "No tickets found in the last ${months} month(s)." and stop.

## Step 3 — First pass: identify symptoms in parallel
Divide the ticket filenames into batches of 5. Invoke the "ticket-batch-analyzer" subagent for EVERY batch IN PARALLEL in a single response — do not wait for one to finish before starting the next.

For each batch subagent call, pass the list of full file paths as the prompt:
"Read and analyze these ticket files, return symptoms as JSON:
/tmp/${connector}_tickets/ticket_X.md
/tmp/${connector}_tickets/ticket_Y.md
..."

Each subagent returns a lightweight JSON array of symptoms. Collect all results.

## Step 4 — Consolidate and rank
Merge all subagent results into one master symptom list:
- Compare every pair of symptom groups — if they describe the same customer-visible symptom (even if worded differently), merge them: combine ticket_ids, keep the highest severity
- Sort by total number of ticket_ids descending (most frequent symptom first)
- Take the top 20 symptoms
- Assign each a unique slug: 3-4 word kebab-case describing the customer symptom (e.g. "binlog-not-syncing", "oauth-token-expired", "pipeline-stuck-ingesting")

## Step 5 — Second pass: write issue files in parallel
For each of the top 20 symptoms, invoke the "issue-file-writer" subagent IN PARALLEL in a single response.

For each subagent call, pass this prompt:
"Symptom: {title}
Output file: ${connectorDir}/{slug}.md
Ticket files:
/tmp/${connector}_tickets/ticket_X.md
/tmp/${connector}_tickets/ticket_Y.md
..."

Each subagent reads the raw tickets and writes the full {slug}.md file directly. Wait for all to complete.

## Step 6 — Write selection.md
Once all issue files are written, write: \`${connectorDir}/selection.md\`

\`\`\`
# ${connector.charAt(0).toUpperCase() + connector.slice(1)} — Issue Index

**{M} tickets → {N} distinct symptoms** (last ${months} month(s))

## Symptom → Issue Mapping

→ **"{error keyword or message}"** → [{title}]({slug}.md)
→ **"{component or behaviour}"** → [{title}]({slug}.md)
...one line per common symptom, using actual keywords from the tickets...

## All Issues (most frequent first)

| Title | Severity | Tickets | File |
|-------|----------|---------|------|
| {title} | {severity} | {count} | [{slug}.md]({slug}.md) |
\`\`\`

Rules:
- Symptom → Issue Mapping must use actual error messages and keywords from the ticket content
- Every issue listed in selection.md must have a corresponding {slug}.md file

Start now with Step 1.
`.trim();
}

// OTEL_LOG_RAW_API_BODIES writes full API request/response JSON to disk.
// loadBodies() reads these files to enrich the HTML trace with messages and tool defs.
const otelEnv: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_LOG_RAW_API_BODIES: `file:/tmp/otel_bodies_${RUN_ID}`,
};

// ---------------------------------------------------------------------------
// Stream helper
// ---------------------------------------------------------------------------
async function runConnector(connector: string, months: number, usePreset: boolean): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Generating skill for: ${connector} (last ${months} month(s))`);
  console.log("=".repeat(60));

  let totalCost = 0;
  const prompt = buildPrompt(connector, months);

  const availableTools: ToolDef[] = [
    { name: "Bash",  type: "builtin", description: "Run shell commands" },
    { name: "Read",  type: "builtin", description: "Read file contents" },
    { name: "Write", type: "builtin", description: "Write file contents" },
    {
      name: "Agent (ticket-batch-analyzer)",
      type: "subagent",
      description: TICKET_BATCH_ANALYZER.description,
      model: TICKET_BATCH_ANALYZER.model,
      tools: TICKET_BATCH_ANALYZER.tools as string[],
    },
    {
      name: "Agent (issue-file-writer)",
      type: "subagent",
      description: ISSUE_FILE_WRITER.description,
      model: ISSUE_FILE_WRITER.model,
      tools: ISSUE_FILE_WRITER.tools as string[],
    },
  ];

  const tracer = new RunTracer(connector, months, RUN_ID, prompt, availableTools);

  for await (const message of tracer.capture(query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      ...(usePreset && { systemPrompt: { type: "preset", preset: "claude_code" } }),
      settingSources: ["user"],
      allowedTools: ["Bash", "Read", "Write", "Agent"],
      permissionMode: "acceptEdits",
      maxTurns: 300,
      cwd: REPO_ROOT,
      agents: {
        "ticket-batch-analyzer": TICKET_BATCH_ANALYZER,
        "issue-file-writer": ISSUE_FILE_WRITER,
      },
      env: { ...process.env, ...otelEnv },
    },
  }))) {
    const msg = message as SDKMessage;

    if (msg.type === "assistant") {
      const assistantMsg = msg as SDKAssistantMessage;
      for (const block of assistantMsg.message.content) {
        if (block.type === "text" && block.text.trim()) {
          process.stdout.write(block.text);
        }
      }
    } else if (msg.type === "result") {
      const result = msg as SDKResultMessage;
      totalCost += result.total_cost_usd ?? 0;
      const models = Object.keys(result.modelUsage ?? {}).join(", ");
      console.log(`\n\n[${connector}] done — success=${!result.is_error}, duration=${result.duration_ms}ms, cost=$${result.total_cost_usd?.toFixed(4)}, models=${models}`);
      await tracer.loadBodies();
      const htmlPath = await tracer.writeReport(
        path.join(SKILL_DIR, connector),
        result.total_cost_usd ?? undefined,
        result.duration_ms ?? undefined,
      );
      console.log(`[${connector}] trace → ${htmlPath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Write top-level SKILL.md after all connectors are done
// ---------------------------------------------------------------------------
async function writeSkillMd(connectors: string[]): Promise<void> {
  await fs.mkdir(SKILL_DIR, { recursive: true });

  const rows = connectors
    .map((c) => `| ${c.charAt(0).toUpperCase() + c.slice(1)} | [${c}/selection.md](${c}/selection.md) |`)
    .join("\n");

  const content = `---
name: connector-oncall
description: Historical oncall patterns from Zendesk support tickets (last 6 months) for all connectors. Use when debugging any connector pipeline issue, investigating customer-reported errors, or looking up past resolutions and root causes.
---

# Connector Oncall Patterns

Historical issue patterns extracted from Zendesk support tickets (last 6 months).

## Connectors

| Connector | Issue Index |
|-----------|-------------|
${rows}

## How to Use

1. Find your connector in the table above
2. Read \`{connector}/selection.md\` — maps symptoms and error keywords to specific issues
3. Read the linked \`issue{N}.md\` — full root cause, resolution, and customer impact
`;

  await fs.writeFile(path.join(SKILL_DIR, "SKILL.md"), content, "utf8");
  console.log(`Written SKILL.md → ${SKILL_DIR}/SKILL.md`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const connectorFlag = args.indexOf("--connector");
  const connectors = connectorFlag !== -1 ? [args[connectorFlag + 1]] : ALL_CONNECTORS;

  const monthsFlag = args.indexOf("--months");
  const months = monthsFlag !== -1 ? parseInt(args[monthsFlag + 1], 10) : 6;

  const usePreset = args.includes("--preset");

  console.log(`Generating skills for: ${connectors.join(", ")} (last ${months} month(s))`);
  console.log(`System prompt: ${usePreset ? "claude_code preset" : "minimal (default)"}`);
  console.log(`Run ID: ${RUN_ID}`);
  console.log(`Output: ${SKILL_DIR}/`);

  const completed: string[] = [];

  for (const connector of connectors) {
    if (!ALL_CONNECTORS.includes(connector)) {
      console.error(`Unknown connector: ${connector}. Valid: ${ALL_CONNECTORS.join(", ")}`);
      process.exit(1);
    }
    await runConnector(connector, months, usePreset);
    completed.push(connector);
  }

  await writeSkillMd(completed);
  console.log("\nAll done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
