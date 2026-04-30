/**
 * Orchestrator tracer — OTLP-based, no SDK stream capture required.
 *
 * Starts a local OTLP HTTP receiver (traces + logs).
 * Each agent gets an env from getAgentEnv(name, type) which stamps
 * OTEL_RESOURCE_ATTRIBUTES so every span/log from that subprocess carries
 * agent.name and agent.type.
 *
 * After all agents finish, call writeReport(dir) to:
 *   1. Wait for OTEL flush
 *   2. Pair api_request_body + api_response_body log events by session + index
 *   3. Read body files for full message history, system prompt, tools
 *   4. Render an HTML trace report
 */

import http from "http";
import fs from "fs/promises";
import path from "path";

// ── Pricing ───────────────────────────────────────────────────────────────────

const PRICING: Record<string, [number, number, number]> = {
  "claude-sonnet-4-6":         [3.00,  0.30,  15.00],
  "claude-sonnet-4-5":         [3.00,  0.30,  15.00],
  "claude-opus-4-6":           [15.00, 1.50,  75.00],
  "claude-haiku-4-5":          [0.80,  0.08,   4.00],
  "claude-haiku-4-5-20251001": [0.80,  0.08,   4.00],
};
const DEFAULT_PRICING: [number, number, number] = [3.00, 0.30, 15.00];

function calcCost(model: string, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  const [ip, cp, op] = PRICING[model] ?? DEFAULT_PRICING;
  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  return (uncached / 1e6) * ip + (cacheRead / 1e6) * cp + (cacheWrite / 1e6) * ip * 1.25 + (output / 1e6) * op;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface RawSpan {
  spanName: string;
  sessionId: string;
  agentName: string;
  agentType: string;
  attrs: Record<string, unknown>;
}

interface RawLog {
  eventName: string;
  sessionId: string;
  agentName: string;
  agentType: string;
  sequence: number;
  attrs: Record<string, unknown>;
}

interface Turn {
  seq: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  ttftMs: number;
  stopReason: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  tools: { name: string; description: string }[];
  responseText: string;
  toolUses: { name: string; input: Record<string, unknown> }[];
}

interface AgentRun {
  name: string;
  type: string;
  sessionId: string;
  turns: Turn[];
}

// ── Receiver ──────────────────────────────────────────────────────────────────

function extractAttrs(rawAttrs: any[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of rawAttrs ?? []) {
    const v = a.value;
    out[a.key] = v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue ?? JSON.stringify(v);
  }
  return out;
}

// ── Tracer ────────────────────────────────────────────────────────────────────

export class OrchestratorTracer {
  private readonly spans: RawSpan[] = [];
  private readonly logs: RawLog[] = [];
  private readonly server: http.Server;
  readonly port: number;
  private readonly bodiesDir: string;
  private readonly startMs = Date.now();
  private liveInterval: ReturnType<typeof setInterval> | null = null;
  private liveHtmlPath: string | null = null;

  constructor(
    private readonly runLabel: string,
    private readonly runId: string,
  ) {
    this.bodiesDir = `/tmp/otel_bodies_${runId}`;
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => (body += c));
      req.on("end", () => {
        try { this.ingest(JSON.parse(body)); } catch { /* ignore malformed */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    this.server.listen(0);
    this.port = (this.server.address() as { port: number }).port;
  }

  private ingest(payload: any): void {
    for (const rs of payload.resourceSpans ?? []) {
      const resAttrs = extractAttrs(rs.resource?.attributes ?? []);
      const agentName = String(resAttrs["agent.name"] ?? "");
      const agentType = String(resAttrs["agent.type"] ?? "");
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          const attrs = extractAttrs(span.attributes ?? []);
          this.spans.push({
            spanName: span.name,
            sessionId: String(attrs["session.id"] ?? ""),
            agentName, agentType, attrs,
          });
        }
      }
    }
    for (const rl of payload.resourceLogs ?? []) {
      const resAttrs = extractAttrs(rl.resource?.attributes ?? []);
      const agentName = String(resAttrs["agent.name"] ?? "");
      const agentType = String(resAttrs["agent.type"] ?? "");
      for (const sl of rl.scopeLogs ?? []) {
        for (const record of sl.logRecords ?? []) {
          const attrs = extractAttrs(record.attributes ?? []);
          this.logs.push({
            eventName: String(attrs["event.name"] ?? ""),
            sessionId: String(attrs["session.id"] ?? ""),
            sequence: Number(attrs["event.sequence"] ?? 0),
            agentName, agentType, attrs,
          });
        }
      }
    }
  }

  /** Returns the base OTEL env vars every agent needs. */
  getBaseEnv(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://localhost:${this.port}/v1/traces`,
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://localhost:${this.port}/v1/logs`,
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_LOGS_EXPORT_INTERVAL: "2000",
      OTEL_TRACES_EXPORT_INTERVAL: "2000",
      OTEL_LOG_RAW_API_BODIES: `file:${this.bodiesDir}`,
      OTEL_LOG_TOOL_CONTENT: "1",
      OTEL_LOG_TOOL_DETAILS: "1",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "",
    };
  }

  /** Returns env vars for a specific agent — stamps agent.name + agent.type onto all its spans/logs. */
  getAgentEnv(name: string, type: string): Record<string, string> {
    const safe = (s: string) => s.replace(/[\s,=]/g, "_");
    return {
      ...this.getBaseEnv(),
      OTEL_RESOURCE_ATTRIBUTES: `agent.name=${safe(name)},agent.type=${safe(type)}`,
    };
  }

  private async buildAgentRuns(): Promise<AgentRun[]> {
    // Map request_id -> llm_request.context from spans (to filter out "standalone" title calls)
    const contextByReqId = new Map<string, string>();
    const spanByReqId = new Map<string, RawSpan>();
    for (const s of this.spans) {
      if (s.spanName !== "claude_code.llm_request") continue;
      const reqId = String(s.attrs["request_id"] ?? "");
      if (!reqId) continue;
      contextByReqId.set(reqId, String(s.attrs["llm_request.context"] ?? "interaction"));
      spanByReqId.set(reqId, s);
    }

    // Pair api_request_body + api_response_body log events per session (sorted by sequence, paired by index)
    const reqLogs = this.logs.filter(l => l.eventName === "api_request_body");
    const resLogs = this.logs.filter(l => l.eventName === "api_response_body");
    const sessions = [...new Set([...reqLogs, ...resLogs].map(l => l.sessionId))];

    const runs = new Map<string, AgentRun>();
    let globalSeq = 0;

    for (const sid of sessions) {
      const reqs = reqLogs.filter(l => l.sessionId === sid).sort((a, b) => a.sequence - b.sequence);
      const ress = resLogs.filter(l => l.sessionId === sid).sort((a, b) => a.sequence - b.sequence);
      const agentName = reqs[0]?.agentName || ress[0]?.agentName || `session_${sid.slice(0, 8)}`;
      const agentType = reqs[0]?.agentType || ress[0]?.agentType || "unknown";

      if (!runs.has(sid)) {
        runs.set(sid, { name: agentName, type: agentType, sessionId: sid, turns: [] });
      }
      const run = runs.get(sid)!;

      const count = Math.min(reqs.length, ress.length);
      for (let i = 0; i < count; i++) {
        const reqBodyRef = String(reqs[i].attrs["body_ref"] ?? "");
        const resBodyRef = String(ress[i].attrs["body_ref"] ?? "");
        const requestId  = String(ress[i].attrs["request_id"] ?? "");

        if (!reqBodyRef || !resBodyRef) continue;

        // Skip internal title-generation calls
        const ctx = contextByReqId.get(requestId);
        if (ctx === "standalone") continue;

        let reqBody: any = {};
        let resBody: any = {};
        try { reqBody = JSON.parse(await fs.readFile(reqBodyRef, "utf8")); } catch { /* skip */ }
        try { resBody = JSON.parse(await fs.readFile(resBodyRef, "utf8")); } catch { /* skip */ }

        const span = spanByReqId.get(requestId);
        const inputTokens       = Number(span?.attrs["input_tokens"]        ?? (resBody.usage?.input_tokens ?? 0));
        const outputTokens      = Number(span?.attrs["output_tokens"]       ?? (resBody.usage?.output_tokens ?? 0));
        const cacheReadTokens   = Number(span?.attrs["cache_read_tokens"]   ?? (resBody.usage?.cache_read_input_tokens ?? 0));
        const cacheCreationTokens = Number(span?.attrs["cache_creation_tokens"] ?? (resBody.usage?.cache_creation_input_tokens ?? 0));
        const model       = String(span?.attrs["model"]       ?? resBody.model ?? "claude-sonnet-4-6");
        const durationMs  = Number(span?.attrs["duration_ms"] ?? 0);
        const ttftMs      = Number(span?.attrs["ttft_ms"]     ?? 0);
        const stopReason  = String(span?.attrs["stop_reason"] ?? resBody.stop_reason ?? "");

        // System prompt
        const sysRaw = reqBody.system ?? [];
        const systemPrompt = Array.isArray(sysRaw)
          ? sysRaw.map((b: any) => (typeof b === "string" ? b : (b.text ?? ""))).join("\n\n")
          : String(sysRaw);

        // Message history
        const messages = (reqBody.messages ?? []).map((m: any) => ({
          role: String(m.role ?? "user"),
          content: renderContent(m.content),
        }));

        // Tool definitions from request
        const tools = (reqBody.tools ?? []).map((t: any) => ({
          name: String(t.name ?? ""),
          description: String(t.description ?? ""),
        }));

        // Response content
        const responseContent = resBody.content ?? [];
        const responseText = responseContent
          .filter((b: any) => b.type === "text")
          .map((b: any) => String(b.text ?? ""))
          .join("\n");
        const toolUses = responseContent
          .filter((b: any) => b.type === "tool_use")
          .map((b: any) => ({ name: String(b.name ?? ""), input: b.input ?? {} }));

        globalSeq++;
        run.turns.push({
          seq: run.turns.length + 1,
          model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
          costUsd: calcCost(model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens),
          durationMs, ttftMs, stopReason,
          systemPrompt, messages, tools, responseText, toolUses,
        });
      }
    }

    return [...runs.values()].filter(r => r.turns.length > 0);
  }

  /** Start writing the HTML every intervalMs so it can be refreshed during the run. */
  startLiveReport(htmlPath: string, intervalMs = 3000): void {
    this.liveHtmlPath = htmlPath;
    this.liveInterval = setInterval(async () => {
      try {
        const runs = await this.buildAgentRuns();
        await fs.mkdir(path.dirname(htmlPath), { recursive: true });
        await fs.writeFile(htmlPath, buildHtml(runs, this.runLabel, this.runId, Date.now() - this.startMs, true), "utf8");
      } catch { /* ignore mid-run errors */ }
    }, intervalMs);
  }

  async writeReport(outputDir: string): Promise<string> {
    if (this.liveInterval) {
      clearInterval(this.liveInterval);
      this.liveInterval = null;
    }
    // Wait for OTEL exporters to flush (interval=2s, wait 5s)
    await new Promise(r => setTimeout(r, 5000));
    await new Promise<void>(resolve => this.server.close(() => resolve()));

    const runs = await this.buildAgentRuns();
    await fs.mkdir(outputDir, { recursive: true });
    const htmlPath = this.liveHtmlPath ?? path.join(outputDir, "trace.html");
    await fs.writeFile(htmlPath, buildHtml(runs, this.runLabel, this.runId, Date.now() - this.startMs, false), "utf8");
    console.log(`  trace → ${htmlPath}`);
    return htmlPath;
  }
}

// ── Content renderer ──────────────────────────────────────────────────────────

function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return (content as any[]).map((b: any) => {
    if (b.type === "text") return String(b.text ?? "");
    if (b.type === "tool_use") return `→ ${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 200)})`;
    if (b.type === "tool_result") {
      const out = Array.isArray(b.content)
        ? b.content.map((c: any) => c.text ?? "").join("")
        : String(b.content ?? "");
      return `[tool_result: ${out.slice(0, 400)}${out.length > 400 ? "…" : ""}]`;
    }
    return JSON.stringify(b);
  }).join("\n");
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const COLOR_PALETTE = ["#3b82f6", "#f59e0b", "#22c55e", "#ef4444", "#a78bfa", "#fb7185"];

function typeColor(type: string, types: string[]): string {
  return COLOR_PALETTE[types.indexOf(type) % COLOR_PALETTE.length] ?? "#3b82f6";
}

function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtMs(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

function bar(cost: number, total: number): string {
  const pct = total ? Math.min(100, (cost / total) * 100) : 0;
  const color = pct < 5 ? "#22c55e" : pct < 15 ? "#f59e0b" : "#ef4444";
  return `<div class="bar-wrap"><div class="bar" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>`;
}

function turnCard(t: Turn, runCost: number, seq: number): string {
  const totalIn = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens;
  const tokenRow = `in=${totalIn.toLocaleString()} out=${t.outputTokens.toLocaleString()} cache_read=${t.cacheReadTokens.toLocaleString()} cache_write=${t.cacheCreationTokens.toLocaleString()}`;

  const toolPills = t.toolUses.length
    ? `<span class="pills">${[...new Set(t.toolUses.map(u => u.name))].map(n => `<span class="pill">${esc(n)}</span>`).join("")}</span>`
    : "";

  // Tools used blocks
  const toolBlocks = t.toolUses.map(u => {
    const args = JSON.stringify(u.input, null, 2);
    return `<div class="tool-block">
  <div class="tool-name">→ <b>${esc(u.name)}</b></div>
  <span class="mono truncated">${esc(args)}</span>
  <button class="show-more">show more</button>
</div>`;
  }).join("");

  // Available tools section
  const availTools = t.tools.length ? `<details class="sub-details">
  <summary>Available tools (${t.tools.length})</summary>
  <div class="sub-body">
    ${t.tools.map(tool => `<div class="tool-def">
      <span class="tool-def-name">${esc(tool.name)}</span>
      ${tool.description ? `<div class="tool-def-desc">${esc(tool.description)}</div>` : ""}
    </div>`).join("")}
  </div>
</details>` : "";

  // Messages section
  const sysBlock = t.systemPrompt
    ? `<div class="msg"><div class="msg-role" style="color:#f59e0b">SYSTEM</div><div class="msg-content">${esc(t.systemPrompt)}</div></div>`
    : "";
  const msgBlocks = t.messages.map(m => {
    const color = m.role === "user" ? "#3b82f6" : "#22c55e";
    return `<div class="msg"><div class="msg-role" style="color:${color}">${esc(m.role.toUpperCase())}</div><div class="msg-content">${esc(m.content)}</div></div>`;
  }).join("");
  const totalMsgCount = t.messages.length + (t.systemPrompt ? 1 : 0);
  const messagesSection = totalMsgCount ? `<details class="sub-details">
  <summary>Messages (${totalMsgCount})</summary>
  <div class="sub-body">${sysBlock}${msgBlocks}</div>
</details>` : "";

  // Response text
  const respBlock = t.responseText
    ? `<div class="resp-text"><span class="mono truncated">${esc(t.responseText)}</span><button class="show-more">show more</button></div>`
    : "";

  return `<div class="call-card">
  <div class="call-header">
    <span class="call-seq">Call ${seq}</span>
    <span class="call-model">${esc(t.model)}</span>
    <span class="call-cost">$${t.costUsd.toFixed(4)}</span>
    <span class="call-dur">${fmtMs(t.durationMs)}</span>
    <span class="call-stop">${esc(t.stopReason)}</span>
    ${toolPills}
    ${bar(t.costUsd, runCost)}
    <span class="chevron">▶</span>
  </div>
  <div class="call-body">
    <div class="token-row">${esc(tokenRow)}</div>
    ${toolBlocks}
    ${respBlock}
    ${availTools}
    ${messagesSection}
  </div>
</div>`;
}

function buildHtml(runs: AgentRun[], runLabel: string, runId: string, totalMs: number, live = false): string {
  const totalCost = runs.reduce((s, r) => s + r.turns.reduce((ss, t) => ss + t.costUsd, 0), 0);
  const orderedTypes = [...new Set(runs.map(r => r.type))];

  // Summary table
  const summaryRows = orderedTypes.flatMap(type => {
    const color = typeColor(type, orderedTypes);
    const header = `<tr class="group-header"><td colspan="4" style="color:${color}">${esc(type)}</td></tr>`;
    const runRows = runs.filter(r => r.type === type).map((r, i) => {
      const cost = r.turns.reduce((s, t) => s + t.costUsd, 0);
      const anchor = `run-${runs.indexOf(r)}`;
      return `<tr data-anchor="${anchor}">
        <td style="padding-left:24px">${esc(r.name)}</td>
        <td>${r.turns.length}</td>
        <td>$${cost.toFixed(4)}</td>
        <td>${bar(cost, totalCost)}</td>
      </tr>`;
    }).join("");
    return header + runRows;
  }).join("");

  const totalCalls = runs.reduce((s, r) => s + r.turns.length, 0);
  const summaryTable = `<table class="summary-table">
  <thead><tr><th>Agent</th><th>LLM Calls</th><th>Cost</th><th>Share</th></tr></thead>
  <tbody>
    ${summaryRows}
    <tr class="total">
      <td>Total <span style="font-weight:400;font-size:11px;color:#94a3b8">${fmtMs(totalMs)}</span></td>
      <td>${totalCalls}</td><td>$${totalCost.toFixed(4)}</td><td></td>
    </tr>
  </tbody>
</table>`;

  // Detail sections
  const details = runs.map((run, i) => {
    const runCost = run.turns.reduce((s, t) => s + t.costUsd, 0);
    const color = typeColor(run.type, orderedTypes);
    const cards = run.turns.map((t, j) => turnCard(t, runCost, j + 1)).join("");
    return `<div class="context-section" id="run-${i}">
  <h3>${esc(run.name)} <span class="type-badge" style="color:${color}">${esc(run.type)}</span></h3>
  <div class="context-meta">${run.turns.length} call${run.turns.length !== 1 ? "s" : ""} · $${runCost.toFixed(4)}</div>
  ${cards}
</div>`;
  }).join("");

  const ts = new Date().toLocaleString();

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trace — ${esc(runLabel)}</title>
<style>
:root{--bg:#0f172a;--surface:#1e293b;--surface2:#2d3748;--border:#334155;--text:#e2e8f0;--dim:#94a3b8;--radius:6px;--mono:'SF Mono','Fira Code',monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;font-size:14px;line-height:1.5}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:baseline;gap:16px;z-index:100}
header h1{font-size:16px}
.meta{font-family:var(--mono);font-size:12px;color:var(--dim)}
main{max-width:980px;margin:0 auto;padding:24px 20px}
h2{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
h3{font-size:15px;margin-bottom:4px}
.section{margin-bottom:40px}
.context-section{margin-bottom:28px;scroll-margin-top:56px}
.context-meta{color:var(--dim);font-size:12px;margin-bottom:10px}
.type-badge{font-size:10px;background:var(--surface2);border-radius:3px;padding:1px 6px;margin-left:8px;font-family:var(--mono);vertical-align:middle}
.summary-table{width:100%;border-collapse:collapse;margin-bottom:20px}
.summary-table th{text-align:left;padding:8px 12px;font-size:12px;color:var(--dim);border-bottom:1px solid var(--border)}
.summary-table td{padding:8px 12px;border-bottom:1px solid var(--border)}
.summary-table tr[data-anchor]{cursor:pointer}
.summary-table tr[data-anchor]:hover td{background:var(--surface)}
.summary-table tr.total td{font-weight:600;border-top:2px dashed var(--border)}
.summary-table tr.group-header td{font-size:11px;background:var(--surface);padding:4px 12px}
.bar-wrap{height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;min-width:80px}
.bar{height:100%;border-radius:3px}
.call-card{border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;overflow:hidden}
.call-header{display:flex;align-items:center;gap:8px;padding:9px 14px;cursor:pointer;user-select:none;background:var(--surface)}
.call-header:hover{background:var(--surface2)}
.call-seq{font-weight:600;min-width:50px;font-size:13px}
.call-model{font-size:11px;background:var(--surface2);border-radius:4px;padding:2px 7px;color:var(--dim)}
.call-cost{font-family:var(--mono);font-size:12px;min-width:65px}
.call-dur{font-family:var(--mono);font-size:11px;color:var(--dim);min-width:45px}
.call-stop{font-size:11px;color:var(--dim)}
.pills{display:flex;flex-wrap:wrap;gap:4px;margin-left:4px}
.pill{font-size:11px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1px 8px;color:var(--dim)}
.chevron{margin-left:auto;color:var(--dim);font-size:10px;transition:transform .15s}
.call-card.open .chevron{transform:rotate(90deg)}
.call-body{display:none;padding:12px 14px;border-top:1px solid var(--border)}
.call-card.open .call-body{display:block}
.token-row{font-family:var(--mono);font-size:11px;color:var(--dim);margin-bottom:10px}
.tool-block{background:var(--surface);border-radius:var(--radius);padding:10px 12px;margin-bottom:8px}
.tool-name{font-size:13px;margin-bottom:6px}
.resp-text{margin-bottom:8px}
.mono{font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-all;display:block}
.truncated{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.truncated.expanded{display:block;-webkit-line-clamp:unset;overflow:visible}
.show-more{font-size:11px;color:#3b82f6;cursor:pointer;background:none;border:none;padding:2px 0;margin-top:2px;display:block}
sub-details{margin-top:10px}
.sub-details{margin-top:10px;border:1px solid var(--border);border-radius:var(--radius)}
.sub-details summary{padding:7px 12px;cursor:pointer;font-size:12px;font-weight:600;color:var(--dim);list-style:none}
.sub-details summary::-webkit-details-marker{display:none}
.sub-details summary::before{content:"▶  ";font-size:10px}
.sub-details[open] summary::before{content:"▼  "}
.sub-body{padding:8px 12px 12px;border-top:1px solid var(--border)}
.tool-def{margin-bottom:10px}
.tool-def:last-child{margin-bottom:0}
.tool-def-name{font-size:12px;font-weight:700;color:#3b82f6;font-family:var(--mono)}
.tool-def-desc{font-size:11px;color:var(--dim);white-space:pre-wrap;margin-top:2px}
.msg{margin-bottom:10px}
.msg-role{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
.msg-content{font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-all;background:var(--surface2);padding:6px 8px;border-radius:var(--radius);max-height:200px;overflow:auto}
.live-badge{margin-left:auto;font-size:11px;color:#22c55e;font-family:var(--mono);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
</style>
</head><body>
<header>
  <h1>Trace</h1>
  <span class="meta">${esc(runLabel)}</span>
  <span class="meta">${esc(runId.slice(0, 8))}</span>
  <span class="meta">${esc(ts)}</span>
  <span class="meta">$${totalCost.toFixed(4)} · ${fmtMs(totalMs)}</span>
  ${live ? `<span class="live-badge">● LIVE — updated ${esc(ts)}</span>` : ""}
</header>
<main>
  <div class="section"><h2>Summary</h2>${summaryTable}</div>
  <div class="section"><h2>Agent Calls (chronological)</h2>${details}</div>
</main>
<script>
document.addEventListener('DOMContentLoaded',function(){
  document.querySelectorAll('.call-header').forEach(function(h){
    h.addEventListener('click',function(){h.closest('.call-card').classList.toggle('open')});
  });
  document.querySelectorAll('.show-more').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      var t=btn.previousElementSibling;
      var exp=t.classList.toggle('expanded');
      btn.textContent=exp?'show less':'show more';
    });
  });
  document.querySelectorAll('tr[data-anchor]').forEach(function(row){
    row.addEventListener('click',function(){
      var el=document.getElementById(row.dataset.anchor);
      if(el)el.scrollIntoView({behavior:'smooth',block:'start'});
    });
  });
});
</script>
</body></html>`;
}
