import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Symptom } from "./types.js";

function buildPrompt(symptom: Symptom, ticketPaths: string[], outputPath: string): string {
  return `You are a support ticket analyst writing a detailed oncall issue file.

Symptom: ${symptom.title}
Output file: ${outputPath}

Read each of the following ticket files using the Read tool:
${ticketPaths.join("\n")}

Then write the issue file to the output path using the Write tool. Follow this exact format:

# ${symptom.title}

**Severity:** ${symptom.severity} | **Tickets:** ${symptom.ticket_ids.length}

## What the Customer Sees
{2-3 sentences describing exactly what the customer experiences, using their own words and exact error messages from the tickets}

## Cause 1: {brief cause label}
**Root Cause:** {detailed technical root cause based on ticket content}

**Resolution:** {specific steps to fix or work around this cause, based on what worked in the tickets}

**Tickets:** {comma-separated ticket IDs for this cause}

## Cause 2: {brief cause label}
...repeat for each distinct root cause found across the tickets...

## All Related Tickets
${symptom.ticket_ids.join(", ")}

Rules:
- Read ALL ticket files before writing
- Extract exact error messages and keywords from the tickets — do not paraphrase
- Group tickets under the cause that best explains them
- If all tickets share the same root cause, write only one Cause section
- Write the file when done — do not return the content as text`;
}

export async function runIssueWriter(
  symptom: Symptom,
  ticketPaths: string[],
  outputPath: string,
  env: Record<string, string>,
): Promise<void> {
  const prompt = buildPrompt(symptom, ticketPaths, outputPath);

  const rawStream = query({
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
  });

  for await (const message of rawStream) {
    const msg = message as SDKMessage;
    if (msg.type === "result" && (msg as SDKResultMessage).is_error) {
      throw new Error(`issue_writer failed for ${symptom.slug}`);
    }
  }
}
