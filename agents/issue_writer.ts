import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestratorTracer } from "../orchestrated_skills/tracer.js";
import type { ToolDef } from "../commons/tracer_commons.js";
import type { Symptom } from "./types.js";

const TOOLS: ToolDef[] = [
  { name: "Read",  type: "builtin", description: "Read file contents" },
  { name: "Write", type: "builtin", description: "Write file contents" },
];

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
  tracer?: OrchestratorTracer,
): Promise<void> {
  const prompt = buildPrompt(symptom, ticketPaths, outputPath);

  const rawStream = query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      allowedTools: ["Read", "Write"],
      permissionMode: "acceptEdits",
      settingSources: ["user"],
      maxTurns: 40,
      env,
    },
  });

  const stream = tracer
    ? tracer.capture(`issue_writer[${symptom.slug}]`, "issue_writer", prompt, TOOLS, rawStream)
    : rawStream;

  for await (const message of stream) {
    const msg = message as SDKMessage;
    if (msg.type === "result" && (msg as SDKResultMessage).is_error) {
      throw new Error(`issue_writer failed for ${symptom.slug}`);
    }
  }
}
