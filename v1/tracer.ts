/**
 * In-process trace capture for the Claude Agent SDK + cost-ledger-style HTML report.
 * Wraps query() and records each assistant turn from the SDK message stream.
 */

import type { SDKMessage, SDKAssistantMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs/promises";
import path from "path";
import {
  PRICING, DEFAULT_PRICING, calcCost,
  CSS, JS, esc, fmtDuration, costBar, costBreakdown,
  toolPills, toolBlock, availableToolsSection, callCard, messagesSection,
  renderContent, extractFirstUserText, extractSystemPrompt, extractToolDefs, buildMessages,
  type ToolUse, type ToolDef, type Turn, type ApiMessage,
} from "../tracer_shared.js";

export type { ToolDef, ApiMessage };

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Body-file helpers ─────────────────────────────────────────────────────────
// (renderContent, extractFirstUserText, extractSystemPrompt, extractToolDefs, buildMessages imported from tracer_shared)

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
        turn.outputTokens = realOut;
        turn.costUsd = calcCost(turn.model, inTokens, realOut, cacheRead, cacheCreate);
        turn.systemPrompt = extractSystemPrompt(req);
        turn.messages = buildMessages(req);
        if (!this.realTools.length) {
          this.realTools = extractToolDefs(req, this.availableTools);
        }
        turnByFp.delete(fp);
      } else {
        const firstUser = extractFirstUserText(req);
        if (firstUser.trim() && !firstUser.includes(promptPrefix)) {
          subPairs.push({ req, res });
        }
      }
    }

    // Group subagent pairs by first user message — same initial prompt = same subagent instance.
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

// ── v1-specific HTML helpers ──────────────────────────────────────────────────
// (messagesSection, callCard imported from tracer_shared)

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
