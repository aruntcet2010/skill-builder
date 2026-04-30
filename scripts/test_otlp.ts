/**
 * End-to-end test: verify OTLP logs give reliable req/res body_ref pairing.
 *
 * Run with: npx tsx scripts/test_otlp.ts
 *
 * What this tests:
 *   1. Local OTLP receiver collects both /v1/traces and /v1/logs
 *   2. Log events api_request_body / api_response_body carry body_ref paths
 *   3. Within a session, pairing by event.sequence gives the right req↔res file
 *   4. Reading those files gives full system prompt, messages, tools, response
 *   5. Two agents run: one trivial (no tools), one with Read tool
 */

import http from "http";
import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs/promises";
import { randomUUID } from "crypto";

const RUN_ID = randomUUID();

// ── OTLP receiver ─────────────────────────────────────────────────────────────

interface OtlpSpan {
  name: string;
  sessionId: string;
  attrs: Record<string, unknown>;
}

interface OtlpLogRecord {
  eventName: string;   // from attributes["event.name"]
  sessionId: string;
  sequence: number;
  attrs: Record<string, unknown>;
}

function extractAttrs(rawAttrs: any[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of rawAttrs ?? []) {
    const v = a.value;
    out[a.key] = v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue ?? JSON.stringify(v);
  }
  return out;
}

function startReceiver(): {
  port: number;
  spans: OtlpSpan[];
  logs: OtlpLogRecord[];
  close: () => Promise<void>;
} {
  const spans: OtlpSpan[] = [];
  const logs: OtlpLogRecord[] = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);

        // Traces: POST /v1/traces
        for (const rs of payload.resourceSpans ?? []) {
          for (const ss of rs.scopeSpans ?? []) {
            for (const span of ss.spans ?? []) {
              const attrs = extractAttrs(span.attributes);
              spans.push({
                name: span.name,
                sessionId: String(attrs["session.id"] ?? ""),
                attrs,
              });
            }
          }
        }

        // Logs: POST /v1/logs
        for (const rl of payload.resourceLogs ?? []) {
          for (const sl of rl.scopeLogs ?? []) {
            for (const record of sl.logRecords ?? []) {
              const attrs = extractAttrs(record.attributes);
              const eventName = String(attrs["event.name"] ?? "");
              const sessionId = String(attrs["session.id"] ?? "");
              const sequence = Number(attrs["event.sequence"] ?? 0);
              logs.push({ eventName, sessionId, sequence, attrs });
            }
          }
        }
      } catch { /* ignore malformed */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });

  server.listen(0);
  const port = (server.address() as { port: number }).port;

  return {
    port, spans, logs,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

// ── Agent runner ──────────────────────────────────────────────────────────────

async function runAgent(
  label: string,
  prompt: string,
  allowedTools: string[],
  env: Record<string, string>,
): Promise<void> {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Agent: ${label}`);
  let output = "";
  const stream = query({
    prompt,
    options: {
      model: "claude-haiku-4-5-20251001",
      allowedTools,
      permissionMode: "acceptEdits",
      settingSources: ["user"],
      maxTurns: 5,
      env,
    },
  });
  for await (const msg of stream as AsyncIterable<SDKMessage>) {
    if (msg.type === "assistant") {
      for (const b of (msg as any).message.content)
        if (b.type === "text") output += b.text;
    } else if (msg.type === "result") {
      const r = msg as SDKResultMessage;
      console.log(`  cost=$${r.total_cost_usd?.toFixed(5)} is_error=${r.is_error}`);
    }
  }
  console.log(`  output: ${output.trim().slice(0, 120)}`);
}

// ── Pairing logic ─────────────────────────────────────────────────────────────

interface Pair {
  sessionId: string;
  reqBodyRef: string;   // path to uuid.request.json
  resBodyRef: string;   // path to request_id.response.json
  requestId: string;
  sequence: number;
}

function buildPairs(logs: OtlpLogRecord[]): Pair[] {
  // Within each session, req and res body events arrive in order but with other
  // events consuming sequence numbers in between. Pair by sorted index within session.
  const reqLogs = logs.filter(l => l.eventName === "api_request_body");
  const resLogs = logs.filter(l => l.eventName === "api_response_body");

  // Group by session
  const sessions = [...new Set([...reqLogs, ...resLogs].map(l => l.sessionId))];
  const pairs: Pair[] = [];

  for (const sid of sessions) {
    const reqs = reqLogs.filter(l => l.sessionId === sid).sort((a, b) => a.sequence - b.sequence);
    const ress = resLogs.filter(l => l.sessionId === sid).sort((a, b) => a.sequence - b.sequence);
    const count = Math.min(reqs.length, ress.length);
    for (let i = 0; i < count; i++) {
      const reqBodyRef = String(reqs[i].attrs["body_ref"] ?? "");
      const resBodyRef = String(ress[i].attrs["body_ref"] ?? "");
      const requestId  = String(ress[i].attrs["request_id"] ?? "");
      if (reqBodyRef && resBodyRef) {
        pairs.push({ sessionId: sid, reqBodyRef, resBodyRef, requestId, sequence: reqs[i].sequence });
      }
    }
  }
  return pairs;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const testFile = `/tmp/otlp_test_${RUN_ID}.txt`;
  await fs.writeFile(testFile, "The secret number is 42.\n", "utf8");

  const receiver = startReceiver();
  console.log(`OTLP receiver on port ${receiver.port}  (run_id=${RUN_ID.slice(0, 8)})`);

  const otelEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    // Traces
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://localhost:${receiver.port}/v1/traces`,
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
    // Logs  (this is what gives us api_request_body / api_response_body events)
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://localhost:${receiver.port}/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_LOGS_EXPORT_INTERVAL: "1000",     // flush quickly
    // Body files on disk (for full untruncated content)
    OTEL_LOG_RAW_API_BODIES: `file:/tmp/otel_bodies_${RUN_ID}`,
    OTEL_LOG_TOOL_CONTENT: "1",
    OTEL_LOG_TOOL_DETAILS: "1",
  };

  // ── Agent 1: no tools ────────────────────────────────────────────────────
  await runAgent("no-tools", "What is 1 + 1? Reply with just the number.", [], otelEnv);

  // ── Agent 2: Read tool ───────────────────────────────────────────────────
  await runAgent(
    "with-Read",
    `Read the file ${testFile} and tell me what the secret number is.`,
    ["Read"],
    otelEnv,
  );

  // Give OTEL exporters time to flush (interval=1s, wait 3s to be safe)
  console.log("\nWaiting for OTEL flush...");
  await new Promise(r => setTimeout(r, 3000));

  // ── Analyse collected data ────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("SPANS received:", receiver.spans.length);
  const llmSpans = receiver.spans.filter(s => s.name === "claude_code.llm_request");
  console.log(`  claude_code.llm_request: ${llmSpans.length}`);
  for (const s of llmSpans) {
    console.log(`    session=${String(s.attrs["session.id"]).slice(0,8)} ` +
      `request_id=${s.attrs["request_id"]} ` +
      `tokens=${s.attrs["input_tokens"]}in/${s.attrs["output_tokens"]}out ` +
      `stop=${s.attrs["stop_reason"]}`);
  }

  console.log(`\nLOGS received: ${receiver.logs.length}`);
  const eventNames = [...new Set(receiver.logs.map(l => l.eventName))];
  console.log(`  distinct event names: ${eventNames.join(", ")}`);
  const reqBodyLogs = receiver.logs.filter(l => l.eventName === "api_request_body");
  const resBodyLogs = receiver.logs.filter(l => l.eventName === "api_response_body");
  console.log(`  api_request_body: ${reqBodyLogs.length}`);
  console.log(`  api_response_body: ${resBodyLogs.length}`);

  // Show body_ref values
  console.log("\n  api_request_body refs:");
  for (const l of reqBodyLogs)
    console.log(`    session=${l.sessionId.slice(0,8)} seq=${l.sequence} body_ref=${l.attrs["body_ref"]}`);
  console.log("\n  api_response_body refs:");
  for (const l of resBodyLogs)
    console.log(`    session=${l.sessionId.slice(0,8)} seq=${l.sequence} body_ref=${l.attrs["body_ref"]} request_id=${l.attrs["request_id"]}`);

  // ── Build pairs and verify ────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("PAIRING via log event sequences:");
  const pairs = buildPairs(receiver.logs);
  console.log(`  Pairs found: ${pairs.length}`);

  for (const pair of pairs) {
    console.log(`\n  Pair (session=${pair.sessionId.slice(0,8)} seq=${pair.sequence})`);
    console.log(`    req: ${pair.reqBodyRef}`);
    console.log(`    res: ${pair.resBodyRef}`);

    // Verify files exist and read interesting bits
    try {
      const reqBody = JSON.parse(await fs.readFile(pair.reqBodyRef, "utf8"));
      const resBody = JSON.parse(await fs.readFile(pair.resBodyRef, "utf8"));

      const systemPrompt = Array.isArray(reqBody.system)
        ? reqBody.system.map((b: any) => b.text ?? "").join("").slice(0, 80)
        : String(reqBody.system ?? "").slice(0, 80);
      const messageCount = reqBody.messages?.length ?? 0;
      const toolCount = reqBody.tools?.length ?? 0;
      const toolNames = (reqBody.tools ?? []).map((t: any) => t.name).join(", ");
      const resText = (resBody.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").slice(0, 100);
      const resToolUses = (resBody.content ?? []).filter((b: any) => b.type === "tool_use").map((b: any) => b.name).join(", ");

      console.log(`    [REQUEST]  messages=${messageCount}  tools=${toolCount} [${toolNames}]`);
      console.log(`    system_prompt: "${systemPrompt}..."`);
      console.log(`    [RESPONSE] stop=${resBody.stop_reason}  usage=${JSON.stringify(resBody.usage)}`);
      if (resText) console.log(`    text: "${resText}"`);
      if (resToolUses) console.log(`    tool_uses: ${resToolUses}`);
    } catch (e: any) {
      console.log(`    ERROR reading files: ${e.message}`);
    }
  }

  // ── Cross-check: pairs vs llm spans ──────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("CROSS-CHECK: does every llm_request span have a matching pair?");
  for (const span of llmSpans) {
    const rid = String(span.attrs["request_id"] ?? "");
    const matched = pairs.find(p => p.requestId === rid);
    console.log(`  span request_id=${rid.slice(0,30)} -> ${matched ? "PAIRED ✓" : "NO PAIR ✗"}`);
  }

  await receiver.close();
  await fs.unlink(testFile).catch(() => {});
  console.log("\nDone.");
}

main().catch(err => { console.error(err); process.exit(1); });
