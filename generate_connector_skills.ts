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
// Subagent definition — ticket batch analyzer
// ---------------------------------------------------------------------------
const TICKET_BATCH_ANALYZER: AgentDefinition = {
  description:
    "Analyzes a batch of raw Zendesk support tickets and extracts distinct issues as a JSON array. " +
    "Use this agent for each batch of 50 tickets that needs to be processed in parallel.",
  prompt: `You are a support ticket analyst. You will receive a batch of raw Zendesk tickets as JSON.

Your job: extract every distinct issue present across these tickets.

For each distinct issue return a JSON object with these fields:
- title: concise issue title (max 15 words)
- severity: "critical" | "high" | "medium" | "low" (use the highest seen across related tickets)
- components: string array of affected components or areas
- description: what the customer experiences (2-3 sentences)
- root_cause: technical root cause (2-3 sentences)
- resolution: how to fix or work around it (2-3 sentences)
- customer_impact: business impact on the customer (1-2 sentences)
- ticket_ids: string array of ticket IDs in this batch that relate to this issue

Rules:
- Group tickets that share the same underlying root cause into one issue
- One ticket can only belong to one issue (pick the best match)
- Return ONLY a valid JSON array — no markdown, no explanation, no code fences
- If a ticket has no useful signal (e.g. spam, test ticket), skip it`,
  // No tools needed — subagent works only with the inline ticket data in its prompt
  tools: [],
  model: "claude-sonnet-4-6",
};

// ---------------------------------------------------------------------------
// Main agent prompt
// ---------------------------------------------------------------------------
function buildPrompt(connector: string): string {
  return `
You are generating a Claude Code skill for the "${connector}" connector from historical Zendesk support tickets.

Work through these steps in order:

## Step 1 — Fetch tickets
\`\`\`
npx tsx ${REPO_ROOT}/scripts/fetch_raw_tickets.ts --connector ${connector} --months 6 --output /tmp/${connector}_raw_tickets.json
\`\`\`

## Step 2 — Read the ticket file
Read /tmp/${connector}_raw_tickets.json and check how many tickets there are.
If 0 tickets, write a minimal SKILL.md saying no tickets found and stop.

## Step 3 — Spawn parallel batch subagents
Divide the tickets into batches of 50. Invoke the "ticket-batch-analyzer" subagent for EVERY batch IN PARALLEL in a single response — do not wait for one to finish before starting the next.

For each batch subagent call, pass the ticket objects as the prompt:
"Analyze these tickets and return issues as JSON:\n<paste the 50 ticket objects as JSON>"

Collect the JSON array returned by each subagent.

## Step 4 — Consolidate
Merge all subagent results into one master issue list:
- Issues with the same root cause → merge (combine ticket_ids, keep highest severity)
- Sort by number of ticket_ids descending (most frequent first)

## Step 5 — Categorize into 6–10 groups
Group issues into 6–10 categories an oncall engineer would recognise.
Use lowercase-hyphenated slugs (e.g. "connection-auth", "replication-cdc", "data-types", "schema-mapping").

## Step 6 — Write skill files
Output base: \`${SKILLS_OUTPUT_DIR}/${connector}-oncall/\`

### SKILL.md
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
| **{Name}** | {one-liner} | [patterns/{slug}/selection.md](patterns/{slug}/selection.md) | {count} |

## How to Use
1. Find the category matching the symptom
2. Read selection.md — maps symptoms/errors to issue numbers
3. Read issues.md — root cause, resolution, customer impact
\`\`\`

### patterns/{slug}/selection.md
\`\`\`
# {Category Name} — Selection Guide

## Symptom → Issue Mapping
→ **"{error keyword}"** → Issue {N}: {title}

## All Issues (most frequent first)
| # | Title | Severity | Tickets |
|---|-------|----------|---------|
| {N} | {title} | {severity} | {count} |

→ Full details: [issues.md](issues.md)
\`\`\`

### patterns/{slug}/issues.md
\`\`\`
# {Category Name} — Full Issue Details

## Issue {N}: {title}
**Severity:** {X} | **Tickets:** {Y} | **Components:** {A, B}

**Description:** ...
**Root Cause:** ...
**Resolution:** ...
**Customer Impact:** ...

---
\`\`\`

Rules:
- Issue numbers in selection.md must match ## Issue N: headers in issues.md
- Use actual error keywords from ticket descriptions in the Symptom → Issue Mapping
- Write each file completely before moving to the next

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
      agents: {
        "ticket-batch-analyzer": TICKET_BATCH_ANALYZER,
      },
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
