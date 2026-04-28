/**
 * Generate Claude Code skills from historical Zendesk tickets (last 6 months).
 * One skill per connector in cdk-patterns format.
 *
 * Usage:
 *   npx tsx generate_connector_skills.ts                    # all connectors
 *   npx tsx generate_connector_skills.ts --connector hubspot # one connector
 */

import { query, type SDKMessage, type SDKAssistantMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const HEVO_AGENT_REPO = path.resolve(REPO_ROOT, "../hevo-connector-agent");
const SKILLS_OUTPUT_DIR = path.join(HEVO_AGENT_REPO, ".claude/skills");

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
// Prompt
// ---------------------------------------------------------------------------
function buildPrompt(connector: string): string {
  return `
You are generating a Claude Code skill for the "${connector}" connector from historical Zendesk support tickets.

## Your Task

Work through these steps in order:

### Step 1 — Fetch tickets
Run this command to fetch the last 6 months of tickets:
\`\`\`
npx tsx ${REPO_ROOT}/scripts/fetch_raw_tickets.ts --connector ${connector} --months 6 --output /tmp/${connector}_raw_tickets.json
\`\`\`

### Step 2 — Check ticket count
\`\`\`
jq length /tmp/${connector}_raw_tickets.json
\`\`\`

### Step 3 — Process tickets in parallel batches of 50

Read the full ticket JSON file. Divide tickets into batches of 50 (or fewer for the last batch).

Spawn ALL batch subagents IN PARALLEL using the Agent tool in a single response. For each batch, give the subagent this task:

> You are analyzing a batch of Zendesk support tickets for the "${connector}" connector.
> Extract every distinct issue you find across these tickets. For each distinct issue, return:
> - title: concise issue title (max 15 words)
> - severity: critical | high | medium | low (use highest seen across tickets)
> - components: array of affected components/areas
> - description: what the customer experiences (2-3 sentences)
> - root_cause: technical root cause (2-3 sentences)
> - resolution: how to fix it (2-3 sentences)
> - customer_impact: business impact on the customer (1-2 sentences)
> - ticket_ids: array of ticket IDs from this batch that relate to this issue
>
> Return ONLY a valid JSON array. No explanation.
>
> Tickets:
> [PASTE THE 50 TICKET OBJECTS HERE AS JSON]

Each subagent returns a JSON array of issues. Collect all results.

### Step 4 — Consolidate issues

Merge the results from all subagents into one master issue list:
- Issues with the same root cause → merge them (combine ticket_ids arrays, keep highest severity)
- Keep all unique issues
- Sort by ticket_ids length descending (most common issues first)

### Step 5 — Categorize into 6–10 groups

Group the consolidated issues into 6–10 logical categories an oncall engineer would recognise (e.g. "connection-auth", "replication-cdc", "data-types", "performance-rate-limiting", "schema-mapping", "object-sync" etc). Use lowercase-hyphenated slugs.

### Step 6 — Write skill files

Write the following files using the exact formats below.

**Output base:** \`${SKILLS_OUTPUT_DIR}/${connector}-oncall/\`

---

#### SKILL.md format

\`\`\`
---
name: ${connector}-oncall
description: Historical oncall patterns for the ${connector} connector (last 6 months). Use when debugging ${connector} pipeline issues, investigating customer-reported errors, or looking up past resolutions. Covers N distinct issues from M tickets.
---

# ${connector.charAt(0).toUpperCase() + connector.slice(1)} Connector — Oncall Patterns

**M tickets → N distinct issues** (last 6 months)

## Issue Categories

| Category | Description | Guide | Issues |
|----------|-------------|-------|--------|
| **{Name}** | {one-liner description} | [patterns/{slug}/selection.md](patterns/{slug}/selection.md) | {count} |
...one row per category...

## How to Use

1. Find the category that matches the customer's symptom in the table above
2. Read \`selection.md\` — it maps error messages and symptoms to specific issues
3. Read \`issues.md\` — full root cause, resolution, and customer impact for each issue
\`\`\`

---

#### patterns/{slug}/selection.md format

\`\`\`
# {Category Name} — Selection Guide

## Symptom → Issue Mapping

→ **"{error keyword or message}"** → Issue {N}: {title}
→ **"{component or behaviour}"** → Issue {N}: {title}
...list the most common symptoms mapped to issue numbers...

## All Issues (most frequent first)

| # | Title | Severity | Tickets |
|---|-------|----------|---------|
| {N} | {title} | {severity} | {count} |
...

→ Full details in [issues.md](issues.md)
\`\`\`

---

#### patterns/{slug}/issues.md format

\`\`\`
# {Category Name} — Full Issue Details

## Issue {N}: {title}

**Severity:** {X} | **Tickets:** {Y} | **Components:** {A, B, C}

**Description:** ...

**Root Cause:** ...

**Resolution:** ...

**Customer Impact:** ...

---
...one block per issue in this category...
\`\`\`

---

## Important Notes

- Write each file completely before moving to the next
- Use the exact frontmatter format for SKILL.md (the --- delimiters and name/description fields are required)
- Issue numbers in selection.md must match the ## Issue N: headers in issues.md
- Symptom → Issue Mapping should use keywords from actual error messages and descriptions found in the tickets
- If ticket count is 0, write a minimal skill saying no tickets found in the last 6 months

Start now with Step 1.
`.trim();
}

// ---------------------------------------------------------------------------
// Stream helper
// ---------------------------------------------------------------------------
async function runConnector(connector: string): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Generating skill for: ${connector}`);
  console.log("=".repeat(60));

  let totalCost = 0;

  for await (const message of query({
    prompt: buildPrompt(connector),
    options: {
      model: "claude-sonnet-4-6",
      settingSources: ["user"],
      allowedTools: ["Bash", "Read", "Write", "Agent"],
      permissionMode: "acceptEdits",
      maxTurns: 300,
      cwd: REPO_ROOT,
    },
  })) {
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
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const connectorFlag = args.indexOf("--connector");
  const connectors =
    connectorFlag !== -1
      ? [args[connectorFlag + 1]]
      : ALL_CONNECTORS;

  console.log(`Generating skills for: ${connectors.join(", ")}`);
  console.log(`Output: ${SKILLS_OUTPUT_DIR}/`);

  for (const connector of connectors) {
    if (!ALL_CONNECTORS.includes(connector)) {
      console.error(`Unknown connector: ${connector}. Valid: ${ALL_CONNECTORS.join(", ")}`);
      process.exit(1);
    }
    await runConnector(connector);
  }

  console.log("\nAll done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
