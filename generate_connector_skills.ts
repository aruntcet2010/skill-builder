/**
 * Generate Claude Code skills from historical Zendesk tickets (last 6 months).
 * One skill per connector in cdk-patterns format.
 *
 * Usage:
 *   npx tsx generate_connector_skills.ts                    # all connectors
 *   npx tsx generate_connector_skills.ts --connector hubspot # one connector
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
// Subagent definition — ticket batch analyzer
// ---------------------------------------------------------------------------
const TICKET_BATCH_ANALYZER: AgentDefinition = {
  description:
    "Reads a batch of Zendesk support ticket markdown files and extracts distinct issues as a JSON array. " +
    "Use this agent for each batch of ticket file paths that needs to be processed in parallel.",
  prompt: `You are a support ticket analyst. You will receive a list of ticket file paths.

Read each file using the Read tool, then extract every distinct issue present across all the tickets.

For each distinct issue return a JSON object with these fields:
- title: concise issue title (max 15 words)
- severity: "critical" | "high" | "medium" | "low" (use the highest seen across related tickets)
- components: string array of affected components or areas
- description: what the customer experiences (2-3 sentences)
- root_cause: technical root cause (2-3 sentences)
- resolution: how to fix or work around it (2-3 sentences)
- customer_impact: business impact on the customer (1-2 sentences)
- ticket_ids: string array of ticket IDs from the files that relate to this issue

Rules:
- Read ALL files before extracting issues
- Group tickets that share the same underlying root cause into one issue
- One ticket can only belong to one issue (pick the best match)
- Return ONLY a valid JSON array — no markdown, no explanation, no code fences
- If a ticket has no useful signal (e.g. spam, test ticket), skip it`,
  tools: ["Read"],
  model: "claude-sonnet-4-6",
};

// ---------------------------------------------------------------------------
// Main agent prompt — only generates {connector}/ files, not SKILL.md
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
If 0 tickets, write ${connectorDir}/selection.md with a single line: "No tickets found in the last 6 months." and stop.

## Step 3 — Spawn parallel batch subagents
Divide the ticket filenames into batches of 50. Invoke the "ticket-batch-analyzer" subagent for EVERY batch IN PARALLEL in a single response — do not wait for one to finish before starting the next.

For each batch subagent call, pass the list of full file paths as the prompt:
"Read and analyze these ticket files, return issues as JSON:
/tmp/${connector}_tickets/ticket_X.md
/tmp/${connector}_tickets/ticket_Y.md
..."

Each subagent reads the files and returns a JSON array of issues. Collect all results.

## Step 4 — Consolidate
Merge all subagent results into one master issue list:
- Issues with the same root cause → merge (combine ticket_ids, keep highest severity)
- Sort by number of ticket_ids descending (most frequent first)
- Number them sequentially: issue1, issue2, issue3...

## Step 4.5 — Save consolidated JSON
Write the full master issue list to /tmp/${connector}_issues.json using the Bash tool:
\`\`\`
echo '<json array>' > /tmp/${connector}_issues.json
\`\`\`
This preserves the raw subagent output for debugging.

## Step 5 — Write one file per issue
For each issue N, write: \`${connectorDir}/issue{N}.md\`

\`\`\`
# Issue {N}: {title}

**Severity:** {X} | **Tickets:** {Y} | **Components:** {A, B}

## Description
{what the customer experiences}

## Root Cause
{technical root cause}

## Resolution
{how to fix or work around it}

## Customer Impact
{business impact}

## Related Tickets
{comma-separated ticket IDs}
\`\`\`

## Step 6 — Write selection.md
Write: \`${connectorDir}/selection.md\`

\`\`\`
# ${connector.charAt(0).toUpperCase() + connector.slice(1)} — Issue Index

**{M} tickets → {N} distinct issues** (last 6 months)

## Symptom → Issue Mapping

→ **"{error keyword or message}"** → [Issue {N}: {title}](issue{N}.md)
→ **"{component or behaviour}"** → [Issue {N}: {title}](issue{N}.md)
...one line per common symptom, using actual keywords from the tickets...

## All Issues (most frequent first)

| # | Title | Severity | Tickets | File |
|---|-------|----------|---------|------|
| {N} | {title} | {severity} | {count} | [issue{N}.md](issue{N}.md) |
\`\`\`

Rules:
- Write all issue files before writing selection.md
- Symptom → Issue Mapping must use actual error messages and keywords from the ticket content
- Every issue listed in selection.md must have a corresponding issue{N}.md file

Start now with Step 1.
`.trim();
}

// ---------------------------------------------------------------------------
// OpenTelemetry env — sends traces/metrics/logs to local Jaeger.
// Start Jaeger: docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
// View traces:  http://localhost:16686
//
// env replaces process.env inside the SDK subprocess, so spread process.env
// first to preserve PATH, ANTHROPIC_API_KEY, etc.
// ---------------------------------------------------------------------------
const otelEnv: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  OTEL_TRACES_EXPORT_INTERVAL: "1000",
  OTEL_METRIC_EXPORT_INTERVAL: "5000",
  OTEL_LOGS_EXPORT_INTERVAL: "1000",
  OTEL_LOG_TOOL_DETAILS: "1",       // tool names, file paths, commands in span attrs
  OTEL_LOG_USER_PROMPTS: "1",       // user prompt text on interaction span
  OTEL_LOG_TOOL_CONTENT: "1",       // full tool input+output bodies (truncated at 60KB)
  OTEL_LOG_RAW_API_BODIES: `file:/tmp/otel_bodies_${RUN_ID}`,  // full API request/response JSON written to disk
  OTEL_SERVICE_NAME: "skill-builder",
};

// ---------------------------------------------------------------------------
// Stream helper
// ---------------------------------------------------------------------------
async function runConnector(connector: string, months: number): Promise<void> {
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
      name: "Agent",
      type: "subagent",
      description: TICKET_BATCH_ANALYZER.description,
      model: TICKET_BATCH_ANALYZER.model,
      tools: TICKET_BATCH_ANALYZER.tools as string[],
    },
  ];

  const tracer = new RunTracer(connector, months, RUN_ID, prompt, availableTools);

  for await (const message of tracer.capture(query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      settingSources: ["user"],
      allowedTools: ["Bash", "Read", "Write", "Agent"],
      permissionMode: "acceptEdits",
      maxTurns: 300,
      cwd: REPO_ROOT,
      agents: {
        "ticket-batch-analyzer": TICKET_BATCH_ANALYZER,
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

  console.log(`Generating skills for: ${connectors.join(", ")} (last ${months} month(s))`);
  console.log(`Run ID: ${RUN_ID}`);
  console.log(`Output: ${SKILL_DIR}/`);

  const completed: string[] = [];

  for (const connector of connectors) {
    if (!ALL_CONNECTORS.includes(connector)) {
      console.error(`Unknown connector: ${connector}. Valid: ${ALL_CONNECTORS.join(", ")}`);
      process.exit(1);
    }
    await runConnector(connector, months);
    completed.push(connector);
  }

  await writeSkillMd(completed);
  console.log("\nAll done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
