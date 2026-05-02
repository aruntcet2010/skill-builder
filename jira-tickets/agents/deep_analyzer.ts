import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";

function buildPrompt(
  issueType: string,
  connectorTitle: string,
  ticketIds: string[],
  dedupJsonPath: string,
  rawDir: string,
  outputJsonPath: string,
  outputMdPath: string,
): string {
  return `You are a Hevo Data oncall analyst doing a deep analysis of a specific issue type.

Issue Type: "${issueType}"
Connector: ${connectorTitle}

Step 1 — Read the deduplicated buckets file using the Read tool to find the exact entry for this issue_type and its pre-classified causes:
${dedupJsonPath}

Step 2 — Read the full ticket content for every ticket in this issue type. Each ticket lives at:
  ${rawDir}/ticket_<KEY>.md

Ticket keys to read (${ticketIds.length} total): ${ticketIds.join(", ")}

Step 3 — Write a structured analysis JSON file using the Write tool:
${outputJsonPath}

The JSON file must contain a single object — no markdown, no code fences, no commentary:

{
  "issue_type": "${issueType}",
  "symptoms": ["<specific symptom observed by customers>", ...],
  "causes": [
    {
      "cause": "<technical root cause>",
      "ticket_ids": ["HEVO-xxx", ...],
      "explanation": "<detailed explanation of why this cause leads to the issue, what conditions trigger it, and how to identify it from ticket content>"
    }
  ],
  "all_ticket_ids": ${JSON.stringify(ticketIds)},
  "patterns": "<recurring themes, configurations, or conditions observed across all tickets in this issue type>"
}

Step 4 — Write the user-facing markdown using the Write tool:
${outputMdPath}

The markdown file must follow this exact format:

# ${issueType}

**Connector**: ${connectorTitle} · **Tickets**: ${ticketIds.length}

## Symptoms

- {one bullet per symptom from the JSON's symptoms array}

## Root Causes

### {cause label from JSON}

**Tickets**: {comma-separated ticket IDs for this cause}

{explanation paragraph from JSON — verbatim or lightly polished prose}

### {next cause label}
...repeat for every entry in causes[]...

## Patterns

{patterns string from JSON, as flowing prose}

## All Tickets

- {one bullet per ticket ID from all_ticket_ids}

Rules:
- Read the deduplicated buckets file AND every listed ticket file before writing
- symptoms: what customers specifically complained about or observed (from descriptions and comments), not internal causes
- causes[].explanation: go deep — explain the technical mechanism, trigger conditions, and how an oncall agent recognizes this from ticket content
- patterns: highlight recurring themes such as specific versions, customer setups, or time-based trends
- all_ticket_ids must include every ticket ID listed above exactly once
- Do not invent information not present in the tickets
- Write BOTH files via the Write tool — do not return content as text
- The markdown must be consistent with the JSON: same causes, same ticket groupings, same patterns`;
}

export async function runDeepAnalyzer(
  issueType: string,
  connectorTitle: string,
  ticketIds: string[],
  dedupJsonPath: string,
  rawDir: string,
  outputJsonPath: string,
  outputMdPath: string,
  env: Record<string, string>,
): Promise<void> {
  process.stderr.write(`  Analyzing: "${issueType}" (${ticketIds.length} tickets)...\n`);

  const prompt = buildPrompt(
    issueType, connectorTitle, ticketIds, dedupJsonPath, rawDir, outputJsonPath, outputMdPath,
  );

  for await (const message of query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      tools: ["Read", "Write"],
      permissionMode: "bypassPermissions",
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 40,
      env,
    },
  })) {
    const msg = message as SDKMessage;
    if (msg.type === "result" && (msg as SDKResultMessage).is_error) {
      throw new Error(`deep_analyzer failed for "${issueType}"`);
    }
  }

  if (!fs.existsSync(outputJsonPath)) {
    process.stderr.write(`  WARNING: deep_analyzer did not write ${outputJsonPath}\n`);
  }
  if (!fs.existsSync(outputMdPath)) {
    process.stderr.write(`  WARNING: deep_analyzer did not write ${outputMdPath}\n`);
  }
}
