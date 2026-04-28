/**
 * In-process trace capture for the Claude Agent SDK + cost-ledger-style HTML report.
 * Wraps query() and records each assistant turn from the SDK message stream.
 */

import type { SDKMessage, SDKAssistantMessage, SDKResultMessage, AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs/promises";
import path from "path";

export interface ToolDef {
  name: string;
  description?: string;
  type: "builtin" | "subagent";
  model?: string;
  tools?: string[];
}

// ── Pricing (USD / million tokens) ───────────────────────────────────────────
// [input, cacheRead, output]; cacheWrite billed at input * 1.25
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

// ── Types ─────────────────────────────────────────────────────────────────────
interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ApiMessage {
  role: "system" | "user" | "assistant";
  content: string;  // rendered as plain text
}

interface Turn {
  seq: number;
  model: string;
  text: string;
  toolUses: ToolUse[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  stopReason: string;
  elapsedMs: number;
  systemPrompt?: string;
  messages?: ApiMessage[];
}

export interface SubagentGroup {
  turns: Turn[];
  tools: ToolDef[];
}

export interface ConnectorTrace {
  connector: string;
  months: number;
  runId: string;
  startedAt: string;
  prompt: string;
  availableTools: ToolDef[];
  turns: Turn[];
  subagentGroups: SubagentGroup[];
  totalCostUsd: number;
  totalDurationMs: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map((b: any) => {
    if (b.type === "text") return b.text ?? "";
    if (b.type === "tool_use") return `→ ${b.name}(${JSON.stringify(b.input ?? {})})`;
    if (b.type === "tool_result") {
      const out = Array.isArray(b.content)
        ? b.content.map((c: any) => c.text ?? "").join("")
        : String(b.content ?? "");
      return `[tool_result: ${out.slice(0, 300)}${out.length > 300 ? "…" : ""}]`;
    }
    return JSON.stringify(b);
  }).join("\n");
}

// ── Body-file helpers ─────────────────────────────────────────────────────────

function extractFirstUserText(req: Record<string, unknown>): string {
  for (const msg of (req as any).messages ?? []) {
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      if (!content.includes("system-reminder") && !content.includes("userEmail")) return content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const t: string = block?.text ?? "";
        if (block?.type === "text" && !t.includes("system-reminder") && !t.includes("userEmail")) return t;
      }
    }
  }
  return "";
}

function extractSystemPrompt(req: Record<string, unknown>): string {
  const sys = (req as any).system ?? [];
  return Array.isArray(sys)
    ? sys.map((b: any) => (typeof b === "string" ? b : b.text ?? "")).join("\n\n")
    : String(sys);
}

function extractToolDefs(req: Record<string, unknown>, fallback: ToolDef[]): ToolDef[] {
  const raw: any[] = (req as any).tools ?? [];
  if (!raw.length) return fallback;
  // Preserve type/model/tools metadata from the original ToolDef list by matching on name
  const metaByName = new Map(fallback.map(t => [t.name, t]));
  return raw.map((t: any) => ({
    name: t.name ?? "",
    description: t.description ?? "",
    type: metaByName.get(t.name)?.type ?? "builtin",
    model: metaByName.get(t.name)?.model,
    tools: metaByName.get(t.name)?.tools,
  }));
}

function buildMessages(req: Record<string, unknown>): ApiMessage[] {
  return ((req as any).messages ?? []).map((m: any) => ({
    role: m.role as "user" | "assistant",
    content: renderContent(m.content),
  }));
}

// ── Tracer ────────────────────────────────────────────────────────────────────
export class RunTracer {
  private turns: Turn[] = [];
  private realTools: ToolDef[] = [];
  private subagentGroups: SubagentGroup[] = [];
  private startMs = Date.now();

  constructor(
    private readonly connector: string,
    private readonly months: number,
    private readonly runId: string,
    private readonly prompt: string,
    private readonly availableTools: ToolDef[] = [],
  ) {}

  async *capture(source: AsyncIterable<SDKMessage>): AsyncIterable<SDKMessage> {
    let seq = 0;
    for await (const msg of source) {
      if (msg.type === "assistant") {
        const a = msg as SDKAssistantMessage;
        // Skip forwarded subagent messages — they appear in the subagent section instead
        if (a.parent_tool_use_id !== null) { yield msg; continue; }
        const m = a.message;
        const usage = (m.usage ?? {}) as Record<string, number>;
        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
        const model = m.model ?? "claude-sonnet-4-6";

        let text = "";
        const toolUses: ToolUse[] = [];
        for (const block of m.content) {
          if (block.type === "text") text += block.text;
          else if (block.type === "tool_use") {
            toolUses.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
          }
        }

        // One LLM API call can emit multiple SDKAssistantMessages (one per tool invocation).
        // They all carry the same token usage. Merge them into one Turn instead of counting each separately.
        const prev = this.turns[this.turns.length - 1];
        const sameCall = prev &&
          prev.inputTokens === inputTokens &&
          prev.outputTokens === outputTokens &&
          prev.cacheReadTokens === cacheReadTokens &&
          prev.cacheCreationTokens === cacheCreationTokens;

        if (sameCall) {
          prev.toolUses.push(...toolUses);
          if (text && !prev.text) prev.text = text.trim();
        } else {
          seq++;
          this.turns.push({
            seq,
            model,
            text: text.trim(),
            toolUses,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            costUsd: calcCost(model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens),
            stopReason: m.stop_reason ?? "",
            elapsedMs: Date.now() - this.startMs,
          });
        }
      }
      yield msg;
    }
  }

  // Enrich turns with system prompt + message history from OTEL_LOG_RAW_API_BODIES=file: output.
  // Also captures subagent turns from body files not matched to the main-agent stream.
  async loadBodies(): Promise<void> {
    const bodiesDir = `/tmp/otel_bodies_${this.runId}`;
    let files: string[];
    try {
      files = await fs.readdir(bodiesDir);
    } catch {
      return;
    }

    const stat = async (f: string) => (await fs.stat(path.join(bodiesDir, f))).mtimeMs;

    const reqFiles = (await Promise.all(
      files.filter(f => f.endsWith(".request.json"))
           .map(async f => ({ f, t: await stat(f) }))
    )).sort((a, b) => a.t - b.t).map(x => x.f);

    const resFiles = (await Promise.all(
      files.filter(f => f.endsWith(".response.json"))
           .map(async f => ({ f, t: await stat(f) }))
    )).sort((a, b) => a.t - b.t).map(x => x.f);

    type Pair = { req: Record<string, unknown>; res: Record<string, unknown> };
    const pairs: Pair[] = [];
    for (let i = 0; i < Math.min(reqFiles.length, resFiles.length); i++) {
      try {
        const req = JSON.parse(await fs.readFile(path.join(bodiesDir, reqFiles[i]), "utf8"));
        const res = JSON.parse(await fs.readFile(path.join(bodiesDir, resFiles[i]), "utf8"));
        pairs.push({ req, res });
      } catch { /* skip malformed */ }
    }
    if (!pairs.length) return;

    // Build a fingerprint → turn lookup from the tracer's captured turns.
    // These fingerprints are ground truth: only real main-agent LLM calls are in this.turns
    // (forwarded subagent messages are already excluded via parent_tool_use_id filtering).
    // Any body pair whose fingerprint matches a tracer turn IS a main-agent pair.
    // Anything that doesn't match is either a subagent call or an internal CC call (title-gen, etc.).
    const turnByFp = new Map<string, Turn>();
    for (const t of this.turns) {
      const fp = `${t.inputTokens}:${t.cacheReadTokens}:${t.cacheCreationTokens}`;
      if (!turnByFp.has(fp)) turnByFp.set(fp, t);
    }

    const subPairs: Pair[] = [];
    const promptPrefix = this.prompt.substring(0, 40);

    for (const { req, res } of pairs) {
      const u = (res as any).usage ?? {};
      const inTokens: number = u.input_tokens ?? 0;
      const cacheRead: number = u.cache_read_input_tokens ?? 0;
      const cacheCreate: number = u.cache_creation_input_tokens ?? 0;
      const realOut: number = u.output_tokens ?? 0;

      const fp = `${inTokens}:${cacheRead}:${cacheCreate}`;
      const turn = turnByFp.get(fp);

      if (turn && !turn.messages) {
        // Matched a main-agent turn — enrich it
        turn.outputTokens = realOut;
        turn.costUsd = calcCost(turn.model, inTokens, realOut, cacheRead, cacheCreate);
        turn.systemPrompt = extractSystemPrompt(req);
        turn.messages = buildMessages(req);
        // Extract real tool definitions from the first matched request
        if (!this.realTools.length) {
          this.realTools = extractToolDefs(req, this.availableTools);
        }
        turnByFp.delete(fp); // prevent duplicate matches
      } else {
        // Not a main-agent call — classify as subagent if user message differs from our prompt
        const firstUser = extractFirstUserText(req);
        if (firstUser.trim() && !firstUser.includes(promptPrefix)) {
          subPairs.push({ req, res });
        }
        // else: internal CC call (title-gen, permission checks, etc.) — skip silently
      }
    }

    // Group subagent pairs by first user message — same initial prompt = same subagent instance.
    // This correctly handles parallel subagents whose body files are interleaved by mtime.
    type Pair = { req: Record<string, unknown>; res: Record<string, unknown> };
    const groupMap = new Map<string, Pair[]>();
    for (const pair of subPairs) {
      const firstUser = extractFirstUserText(pair.req).slice(0, 300);
      if (!groupMap.has(firstUser)) groupMap.set(firstUser, []);
      groupMap.get(firstUser)!.push(pair);
    }

    for (const pairs of groupMap.values()) {
      const tools = extractToolDefs(pairs[0].req, []);
      const turns: Turn[] = [];
      let seq = 0;
      let systemPrompt = "";

      for (const { req, res } of pairs) {
        seq++;
        const u = (res as any).usage ?? {};
        const inTokens: number = u.input_tokens ?? 0;
        const cacheRead: number = u.cache_read_input_tokens ?? 0;
        const cacheCreate: number = u.cache_creation_input_tokens ?? 0;
        const outTokens: number = u.output_tokens ?? 0;
        const model: string = (res as any).model ?? "";

        let text = "";
        const toolUses: ToolUse[] = [];
        for (const block of (res as any).content ?? []) {
          if (block.type === "text") text += block.text ?? "";
          else if (block.type === "tool_use") {
            toolUses.push({ id: block.id, name: block.name, input: block.input ?? {} });
          }
        }

        if (!systemPrompt) systemPrompt = extractSystemPrompt(req);

        turns.push({
          seq,
          model,
          text: text.trim(),
          toolUses,
          inputTokens: inTokens,
          outputTokens: outTokens,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreate,
          costUsd: calcCost(model, inTokens, outTokens, cacheRead, cacheCreate),
          stopReason: (res as any).stop_reason ?? "",
          elapsedMs: 0,
          systemPrompt,
          messages: buildMessages(req),
        });
      }
      this.subagentGroups.push({ turns, tools });
    }
  }

  async writeReport(outputDir: string, totalCostUsd?: number, totalDurationMs?: number): Promise<string> {
    const trace: ConnectorTrace = {
      connector: this.connector,
      months: this.months,
      runId: this.runId,
      startedAt: new Date(this.startMs).toISOString(),
      prompt: this.prompt,
      availableTools: this.realTools.length ? this.realTools : this.availableTools,
      turns: this.turns,
      subagentGroups: this.subagentGroups,
      totalCostUsd: totalCostUsd ?? this.turns.reduce((s, t) => s + t.costUsd, 0),
      totalDurationMs: totalDurationMs ?? Date.now() - this.startMs,
    };
    await fs.mkdir(outputDir, { recursive: true });
    const htmlPath = path.join(outputDir, "trace.html");
    await fs.writeFile(htmlPath, buildHtml(trace), "utf8");
    return htmlPath;
  }
}

// ── HTML helpers (exact CSS/JS from cost-ledger) ──────────────────────────────

const CSS = `
:root {
  --bg: #0f172a; --surface: #1e293b; --surface2: #2d3748;
  --border: #334155; --text: #e2e8f0; --text-dim: #94a3b8;
  --accent: #3b82f6; --green: #22c55e; --amber: #f59e0b; --red: #ef4444;
  --radius: 6px; --mono: 'SF Mono','Fira Code',monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: system-ui,sans-serif; font-size: 14px; line-height: 1.5; }
header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; align-items: baseline; gap: 16px; z-index: 100; }
header h1 { font-size: 16px; }
.run-meta { font-family: var(--mono); font-size: 12px; color: var(--text-dim); }
main { max-width: 980px; margin: 0 auto; padding: 24px 20px; }
h2 { font-size: 13px; color: var(--text-dim); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 12px; }
h3 { font-size: 15px; margin-bottom: 4px; }
.section { margin-bottom: 40px; }
.context-section { margin-bottom: 28px; scroll-margin-top: 56px; }
.context-meta { color: var(--text-dim); font-size: 12px; margin-bottom: 10px; }
.task-desc { background: var(--surface); border-left: 3px solid var(--accent); padding: 8px 12px; font-size: 12px; color: var(--text-dim); margin-bottom: 12px; white-space: pre-wrap; border-radius: 0 var(--radius) var(--radius) 0; max-height: 120px; overflow: auto; }
.summary-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
.summary-table th { text-align: left; padding: 8px 12px; font-size: 12px; color: var(--text-dim); border-bottom: 1px solid var(--border); }
.summary-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.summary-table tr[data-anchor] { cursor: pointer; }
.summary-table tr[data-anchor]:hover td { background: var(--surface); }
.summary-table tr.total td { font-weight: 600; border-top: 2px dashed var(--border); }
.bar-wrap { height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; min-width: 80px; }
.bar { height: 100%; border-radius: 3px; transition: width .3s; }
.call-card { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; overflow: hidden; }
.call-header { display: flex; align-items: center; gap: 10px; padding: 9px 14px; cursor: pointer; user-select: none; background: var(--surface); }
.call-header:hover { background: var(--surface2); }
.call-seq { font-weight: 600; min-width: 54px; font-size: 13px; }
.call-model { font-size: 11px; background: var(--surface2); border-radius: 4px; padding: 2px 7px; color: var(--text-dim); }
.call-cost { font-family: var(--mono); font-size: 12px; min-width: 68px; }
.call-elapsed { font-family: var(--mono); font-size: 11px; color: var(--text-dim); opacity: 0.6; }
.tool-pills { display: flex; flex-wrap: wrap; gap: 4px; margin-left: 4px; }
.tool-pill { font-size: 11px; background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; color: var(--text-dim); white-space: nowrap; }
.tool-pill.task { color: var(--accent); border-color: var(--accent); opacity: 0.8; }
.chevron { margin-left: auto; color: var(--text-dim); font-size: 10px; transition: transform .15s; }
.call-card.open .chevron { transform: rotate(90deg); }
.call-body { display: none; padding: 12px 14px; border-top: 1px solid var(--border); }
.call-card.open .call-body { display: block; }
.token-row { font-family: var(--mono); font-size: 11px; color: var(--text-dim); margin-bottom: 10px; }
.thought { background: var(--surface); border-left: 3px solid var(--text-dim); padding: 8px 12px; border-radius: 0 var(--radius) var(--radius) 0; font-style: italic; color: var(--text-dim); font-size: 13px; margin-bottom: 10px; white-space: pre-wrap; }
.tool-block { background: var(--surface); border-radius: var(--radius); padding: 10px 12px; margin-bottom: 8px; }
.tool-name { font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.badge { font-weight: 400; font-size: 11px; background: var(--surface2); border-radius: 4px; padding: 1px 7px; color: var(--accent); }
.tool-label { font-size: 11px; color: var(--text-dim); margin: 6px 0 3px; }
.tool-value { font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-all; display: block; }
.truncated { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.truncated.expanded { display: block; -webkit-line-clamp: unset; overflow: visible; }
.show-more { font-size: 11px; color: var(--accent); cursor: pointer; background: none; border: none; padding: 2px 0; margin-top: 2px; display: block; }
.cost-breakdown { font-size: 11px; color: var(--text-dim); margin-top: 4px; margin-bottom: 10px; }
.cost-breakdown .cb-label { opacity: 0.7; }
.cost-breakdown .cb-val { font-family: var(--mono); color: var(--text); }
.cost-breakdown .cb-pct { opacity: 0.5; }
details.available-tools { margin-top: 10px; border: 1px solid var(--border); border-radius: var(--radius); }
details.available-tools summary { padding: 7px 12px; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--text-dim); list-style: none; }
details.available-tools summary::-webkit-details-marker { display: none; }
details.available-tools summary::before { content: "▶  "; font-size: 10px; }
details.available-tools[open] summary::before { content: "▼  "; }
.tools-list { padding: 8px 12px 12px; border-top: 1px solid var(--border); }
.tool-def { margin-bottom: 12px; }
.tool-def:last-child { margin-bottom: 0; }
.tool-def-name { font-size: 12px; font-weight: 700; color: var(--accent); margin-bottom: 2px; font-family: var(--mono); }
.tool-def-type { font-size: 10px; color: var(--text-dim); background: var(--surface2); border-radius: 3px; padding: 1px 5px; margin-left: 6px; font-family: var(--mono); vertical-align: middle; }
.tool-def-desc { font-size: 11px; color: var(--text-dim); white-space: pre-wrap; margin-bottom: 4px; }
.tool-def-meta { font-size: 11px; color: var(--text-dim); font-family: var(--mono); }
details.messages { margin-top: 12px; border: 1px solid var(--border); border-radius: var(--radius); }
details.messages summary { padding: 7px 12px; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--text-dim); list-style: none; }
details.messages summary::-webkit-details-marker { display: none; }
details.messages summary::before { content: "▶  "; font-size: 10px; }
details.messages[open] summary::before { content: "▼  "; }
.msg-list { padding: 8px 12px 12px; border-top: 1px solid var(--border); }
.msg { margin-bottom: 10px; }
.msg-role { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 3px; }
.msg-role.human { color: var(--accent); }
.msg-content { font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-all; background: var(--surface2); padding: 6px 8px; border-radius: var(--radius); max-height: 200px; overflow: auto; }
`;

const JS = `
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.call-header').forEach(function(h) {
    h.addEventListener('click', function() { h.closest('.call-card').classList.toggle('open'); });
  });
  document.querySelectorAll('.show-more').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var t = btn.previousElementSibling;
      var exp = t.classList.toggle('expanded');
      btn.textContent = exp ? 'show less' : 'show more';
    });
  });
  document.querySelectorAll('tr[data-anchor]').forEach(function(row) {
    row.addEventListener('click', function() {
      var el = document.getElementById(row.dataset.anchor);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
});
`;

function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

function costBar(cost: number, total: number): string {
  const pct = total ? Math.min(100, (cost / total) * 100) : 0;
  const color = pct < 5 ? "var(--green)" : pct < 15 ? "var(--amber)" : "var(--red)";
  return `<div class="bar-wrap"><div class="bar" style="width:${pct.toFixed(1)}%;background:${color}" title="$${cost.toFixed(4)}"></div></div>`;
}

function toolPills(toolUses: ToolUse[]): string {
  if (!toolUses.length) return "";
  const counts: Record<string, number> = {};
  for (const t of toolUses) counts[t.name] = (counts[t.name] ?? 0) + 1;
  const pills = Object.entries(counts).map(([name, count]) => {
    const label = count > 1 ? `${esc(name)} ×${count}` : esc(name);
    const cls = name === "Agent" ? "tool-pill task" : "tool-pill";
    return `<span class="${cls}">${label}</span>`;
  });
  return `<div class="tool-pills">${pills.join("")}</div>`;
}

function toolBlock(t: ToolUse): string {
  const argsStr = JSON.stringify(t.input, null, 2);
  const isAgent = t.name === "Agent";
  const agentNote = isAgent
    ? `<div class="tool-label" style="color:var(--accent)">↳ subagent internals not captured in SDK stream</div>`
    : "";
  return `<div class="tool-block">
  <div class="tool-name">→ <span class="badge">${esc(t.name)}</span></div>
  ${agentNote}
  <div class="tool-label">Args</div>
  <span class="tool-value truncated">${esc(argsStr)}</span>
  <button class="show-more">show more</button>
</div>`;
}

function costBreakdown(turns: Turn[]): string {
  let inputCost = 0, cacheReadCost = 0, cacheWriteCost = 0, outputCost = 0;
  for (const t of turns) {
    const [ip, cp, op] = PRICING[t.model] ?? DEFAULT_PRICING;
    const uncached = Math.max(0, t.inputTokens - t.cacheReadTokens - t.cacheCreationTokens);
    inputCost     += (uncached             / 1e6) * ip;
    cacheReadCost += (t.cacheReadTokens    / 1e6) * cp;
    cacheWriteCost += (t.cacheCreationTokens / 1e6) * ip * 1.25;
    outputCost    += (t.outputTokens       / 1e6) * op;
  }
  const total = inputCost + cacheReadCost + cacheWriteCost + outputCost || 1;
  const cats: [string, number][] = [
    ["input", inputCost], ["cache read", cacheReadCost],
    ["cache write", cacheWriteCost], ["output", outputCost],
  ];
  const parts = cats
    .filter(([, v]) => v / total >= 0.005)
    .map(([label, v]) =>
      `<span class="cb-label">${label}</span> <span class="cb-val">$${v.toFixed(4)}</span> <span class="cb-pct">(${(v / total * 100).toFixed(0)}%)</span>`
    );
  return `<div class="cost-breakdown">${parts.join(" &nbsp;·&nbsp; ")}</div>`;
}

function messagesSection(turn: Turn, prompt: string): string {
  if (turn.messages && turn.messages.length > 0) {
    const sys = turn.systemPrompt
      ? `<div class="msg"><div class="msg-role" style="color:var(--amber)">SYSTEM</div><div class="msg-content">${esc(turn.systemPrompt)}</div></div>`
      : "";
    const msgs = turn.messages.map(m => {
      const roleColor = m.role === "user" ? "var(--accent)" : "var(--green)";
      return `<div class="msg">
  <div class="msg-role" style="color:${roleColor}">${esc(m.role.toUpperCase())}</div>
  <div class="msg-content">${esc(m.content)}</div>
</div>`;
    }).join("");
    return `<details class="messages">
  <summary>Messages (${turn.messages.length + (turn.systemPrompt ? 1 : 0)})</summary>
  <div class="msg-list">${sys}${msgs}</div>
</details>`;
  }
  // Fallback: show initial prompt as user message
  if (turn.seq === 1) {
    return `<details class="messages">
  <summary>Initial prompt</summary>
  <div class="msg-list">
    <div class="msg">
      <div class="msg-role" style="color:var(--accent)">USER</div>
      <div class="msg-content">${esc(prompt)}</div>
    </div>
  </div>
</details>`;
  }
  return "";
}

function availableToolsSection(tools: ToolDef[]): string {
  if (!tools.length) return "";
  const items = tools.map(t => {
    const typeBadge = `<span class="tool-def-type">${esc(t.type)}</span>`;
    const desc = t.description ? `<div class="tool-def-desc">${esc(t.description)}</div>` : "";
    const meta = t.type === "subagent"
      ? `<div class="tool-def-meta">model: ${esc(t.model ?? "—")} · tools: ${esc((t.tools ?? []).join(", ") || "—")}</div>`
      : "";
    return `<div class="tool-def"><div class="tool-def-name">${esc(t.name)}${typeBadge}</div>${desc}${meta}</div>`;
  }).join("");
  return `<details class="available-tools">
  <summary>Available tools (${tools.length})</summary>
  <div class="tools-list">${items}</div>
</details>`;
}

function callCard(turn: Turn, totalCost: number, prompt: string, tools: ToolDef[] = []): string {
  const tokenRow = `in=${turn.inputTokens.toLocaleString()} | out=${turn.outputTokens.toLocaleString()} | cache_read=${turn.cacheReadTokens.toLocaleString()} | cache_creation=${turn.cacheCreationTokens.toLocaleString()}`;
  const elapsed = `<span class="call-elapsed">@ ${fmtDuration(turn.elapsedMs)}</span>`;
  const thought = turn.text ? `<div class="thought">${esc(turn.text)}</div>` : "";
  const toolBlocks = turn.toolUses.map(toolBlock).join("");
  return `<div class="call-card">
  <div class="call-header">
    <span class="call-seq">Call ${turn.seq}</span>
    <span class="call-model">${esc(turn.model)}</span>
    <span class="call-cost">$${turn.costUsd.toFixed(4)}</span>
    ${elapsed}
    ${toolPills(turn.toolUses)}
    ${costBar(turn.costUsd, totalCost)}
    <span class="chevron">▶</span>
  </div>
  <div class="call-body">
    <div class="token-row">${esc(tokenRow)}</div>
    ${thought}${toolBlocks}
    ${availableToolsSection(tools)}
    ${messagesSection(turn, prompt)}
  </div>
</div>`;
}

function summaryTable(trace: ConnectorTrace): string {
  const n = trace.turns.length;
  const dur = fmtDuration(trace.totalDurationMs);
  const mainCost = trace.turns.reduce((s, t) => s + t.costUsd, 0);
  const total = trace.totalCostUsd;

  const subRows = trace.subagentGroups.map((g, i) => {
    const ns = g.turns.length;
    const cost = g.turns.reduce((s, t) => s + t.costUsd, 0);
    const label = trace.subagentGroups.length > 1 ? `Subagent ${i + 1}` : "Subagent";
    return `<tr data-anchor="subagent-${i}">
      <td>${label}</td><td>${ns}</td>
      <td>$${cost.toFixed(4)}</td>
      <td>${costBar(cost, total)}</td>
    </tr>`;
  }).join("");

  const totalCalls = n + trace.subagentGroups.reduce((s, g) => s + g.turns.length, 0);

  return `<table class="summary-table">
  <thead><tr><th>Context</th><th>LLM Calls</th><th>Cost</th><th>Share</th></tr></thead>
  <tbody>
    <tr data-anchor="main-agent">
      <td>Main Agent</td><td>${n}</td>
      <td>$${mainCost.toFixed(4)}</td>
      <td>${costBar(mainCost, total)}</td>
    </tr>
    ${subRows}
    <tr class="total">
      <td>Total &nbsp;<span style="font-weight:400;font-size:11px;color:var(--text-dim)">${dur}</span></td>
      <td>${totalCalls}</td><td>$${total.toFixed(4)}</td><td></td>
    </tr>
  </tbody>
</table>`;
}

function buildHtml(trace: ConnectorTrace): string {
  const model = trace.turns[0]?.model ?? "claude-sonnet-4-6";
  const n = trace.turns.length;
  const dur = fmtDuration(trace.totalDurationMs);
  const mainCost = trace.turns.reduce((s, t) => s + t.costUsd, 0);
  const meta = `${n} call${n !== 1 ? "s" : ""} · ${esc(model)} · $${mainCost.toFixed(4)} · ${dur}`;
  const cards = trace.turns.map((t, i) => callCard(t, mainCost, trace.prompt, i === 0 ? trace.availableTools : [])).join("");
  const ts = new Date(trace.startedAt).toLocaleString();

  const subSection = trace.subagentGroups.map((g, i) => {
    const ns = g.turns.length;
    const subModel = g.turns[0]?.model ?? "claude-sonnet-4-6";
    const subCost = g.turns.reduce((s, t) => s + t.costUsd, 0);
    const label = trace.subagentGroups.length > 1
      ? `Subagent ${i + 1}: ticket-batch-analyzer`
      : "Subagent: ticket-batch-analyzer";
    const subMeta = `${ns} call${ns !== 1 ? "s" : ""} · ${esc(subModel)} · $${subCost.toFixed(4)}`;
    const subCards = g.turns.map((t, j) => callCard(t, subCost, "", j === 0 ? g.tools : [])).join("");
    return `<div class="context-section" id="subagent-${i}">
      <h3>${esc(label)}</h3>
      <div class="context-meta">${subMeta}</div>
      ${costBreakdown(g.turns)}
      ${subCards}
    </div>`;
  }).join("");

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trace — ${esc(trace.connector)} — ${esc(trace.runId)}</title>
<style>${CSS}</style>
</head><body>
<header>
  <h1>Trace</h1>
  <span class="run-meta">${esc(trace.connector)} · ${esc(trace.months)}mo</span>
  <span class="run-meta">${esc(trace.runId.slice(0, 8))}</span>
  <span class="run-meta">${esc(ts)}</span>
</header>
<main>
  <div class="section"><h2>Summary</h2>${summaryTable(trace)}</div>
  <div class="section"><h2>Details</h2>
    <div class="context-section" id="main-agent">
      <h3>Main Agent</h3>
      <div class="context-meta">${meta}</div>
      ${costBreakdown(trace.turns)}
      <div class="task-desc">${esc(trace.prompt)}</div>
      ${cards}
    </div>
    ${subSection}
  </div>
</main>
<script>${JS}</script>
</body></html>`;
}
