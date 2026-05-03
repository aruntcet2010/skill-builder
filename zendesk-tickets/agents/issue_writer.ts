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
- A root cause or resolution is CONFIRMED if a support staff member stated it directly as a fact in any comment or internal note — even if the ticket's RCA field is marked unknown or the ticket closed without customer confirmation. A root cause or resolution is UNCONFIRMED if support staff used hedging words ("suspect", "likely", "may be", "could be", "possibly", "appears to"), or if only a customer hypothesis or automated tool suggested it with no staff endorsement. Prefix with "Unconfirmed:" only in the second case — do not apply it to facts stated plainly by support staff
- Do not generalise code examples, API endpoints, or commands beyond what the tickets explicitly show — if an example only applies to a specific object type or configuration, scope it accordingly; replace any ticket-specific values (field names, IDs, table names) with placeholders like <field_name> or <object_type> unless the specific value is itself the point of the example
- Every Cause section must include its own concrete resolution steps — do not substitute a reference or pointer to another Cause section; if the ticket only explains why the problem occurs without a confirmed fix, state what the customer was advised and whether it was confirmed
- Do not include customer or company names — use "a customer" or "affected accounts" instead
- Do not include support tier labels (L1, L2, L3) — use "escalated internally" instead
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
