import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Symptom } from "./types.js";

function buildPrompt(symptom: Symptom, ticketPaths: string[], outputPath: string): string {
  return `You are a support ticket analyst writing a detailed oncall issue file.

Problem: ${symptom.title}
Output file: ${outputPath}

Read each of the following ticket files using the Read tool:
${ticketPaths.join("\n")}

Then write the issue file to the output path using the Write tool. Follow this exact format:

# ${symptom.title}

**Tickets:** ${symptom.ticket_ids.length}

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
- Order resolution steps by what actually resolved the ticket first — put the confirmed fix before alternatives or workarounds
- If a resolution step was tried in a ticket but abandoned in favour of a different approach, do not include the abandoned step
- If a resolution was not confirmed by the customer or support staff (ticket closed without confirmation, root cause marked as unknown, or support staff used words like "suspect", "likely", "may be"), say so explicitly — do not present unverified explanations as confirmed facts; prefix such statements with "Unconfirmed:" in the file
- Do not generalise code examples, API endpoints, or commands beyond what the tickets explicitly show — if an example only applies to a specific object type or configuration, scope it accordingly; replace any ticket-specific values (field names, IDs, table names) with placeholders like <field_name> or <object_type> unless the specific value is itself the point of the example
- Every Cause section must include its own concrete resolution steps — do not substitute a reference or pointer to another Cause section; if the ticket only explains why the problem occurs without a confirmed fix, state what the customer was advised and whether it was confirmed
- Do not include customer or company names — use "a customer" or "affected accounts" instead
- Do not include support tier labels (L1, L2, L3) — use "escalated internally" instead
- Read the output file path before writing to it (even if it does not exist yet — that is fine)
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
