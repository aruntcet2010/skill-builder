/**
 * Tracer for the v2 TypeScript orchestrator.
 * Captures multiple named agent runs (batch_analyzer, consolidator, issue_writer)
 * and renders them as a single HTML trace with a chronological call stack.
 */

import type { SDKMessage, SDKAssistantMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs/promises";
import path from "path";
import {
  calcCost, CSS, JS, esc, fmtDuration, costBar,
  costBreakdown, callCard, availableToolsSection,
  type Turn, type ToolDef, type ToolUse,
} from "./tracer_shared.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentType = "batch_analyzer" | "consolidator" | "issue_writer";

export interface AgentRun {
  name: string;
  type: AgentType;
  prompt: string;
  tools: ToolDef[];
  turns: Turn[];
  startedAt: string;
  totalCostUsd: number;
  totalDurationMs: number;
}

export interface OrchestratorTrace {
  connector: string;
  months: number;
  runId: string;
  startedAt: string;
  agentRuns: AgentRun[];
  totalCostUsd: number;
  totalDurationMs: number;
}

// ── Tracer ────────────────────────────────────────────────────────────────────

export class OrchestratorTracer {
  private agentRuns: AgentRun[] = [];
  private startMs = Date.now();

  constructor(
    private readonly connector: string,
    private readonly months: number,
    private readonly runId: string,
  ) {}

  async *capture(
    name: string,
    type: AgentType,
    prompt: string,
    tools: ToolDef[],
    source: AsyncIterable<SDKMessage>,
  ): AsyncIterable<SDKMessage> {
    const startMs = Date.now();
    const turns: Turn[] = [];
    let seq = 0;

    for await (const msg of source) {
      if (msg.type === "assistant") {
        const a = msg as SDKAssistantMessage;
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

        // Merge messages from the same LLM call (SDK can emit multiple assistant messages per call)
        const prev = turns[turns.length - 1];
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
          turns.push({
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
            elapsedMs: Date.now() - startMs,
          });
        }
      } else if (msg.type === "result") {
        const r = msg as SDKResultMessage;
        this.agentRuns.push({
          name,
          type,
          prompt,
          tools,
          turns,
          startedAt: new Date(startMs).toISOString(),
          totalCostUsd: r.total_cost_usd ?? turns.reduce((s, t) => s + t.costUsd, 0),
          totalDurationMs: Date.now() - startMs,
        });
      }
      yield msg;
    }
  }

  async writeReport(outputDir: string): Promise<string> {
    const trace: OrchestratorTrace = {
      connector: this.connector,
      months: this.months,
      runId: this.runId,
      startedAt: new Date(this.startMs).toISOString(),
      agentRuns: this.agentRuns,
      totalCostUsd: this.agentRuns.reduce((s, r) => s + r.totalCostUsd, 0),
      totalDurationMs: Date.now() - this.startMs,
    };
    await fs.mkdir(outputDir, { recursive: true });
    const htmlPath = path.join(outputDir, "trace.html");
    await fs.writeFile(htmlPath, buildHtml(trace), "utf8");
    return htmlPath;
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<AgentType, string> = {
  batch_analyzer: "var(--accent)",
  consolidator:   "var(--amber)",
  issue_writer:   "var(--green)",
};

function summaryTable(trace: OrchestratorTrace): string {
  const total = trace.totalCostUsd || 0.0001;
  const totalCalls = trace.agentRuns.reduce((s, r) => s + r.turns.length, 0);

  const groups: AgentType[] = ["batch_analyzer", "consolidator", "issue_writer"];
  const rows = groups.flatMap(type => {
    const runs = trace.agentRuns.filter(r => r.type === type);
    if (!runs.length) return [];
    const groupLabel = type.replace(/_/g, " ");
    const header = `<tr class="group-header"><td colspan="4">${groupLabel}</td></tr>`;
    const runRows = runs.map((r, i) => {
      const anchor = `run-${trace.agentRuns.indexOf(r)}`;
      return `<tr data-anchor="${anchor}">
        <td style="padding-left:24px">${esc(r.name)}</td>
        <td>${r.turns.length}</td>
        <td>$${r.totalCostUsd.toFixed(4)}</td>
        <td>${costBar(r.totalCostUsd, total)}</td>
      </tr>`;
    }).join("");
    return [header + runRows];
  }).join("");

  const dur = fmtDuration(trace.totalDurationMs);
  return `<table class="summary-table">
  <thead><tr><th>Agent</th><th>LLM Calls</th><th>Cost</th><th>Share</th></tr></thead>
  <tbody>
    ${rows}
    <tr class="total">
      <td>Total &nbsp;<span style="font-weight:400;font-size:11px;color:var(--text-dim)">${dur}</span></td>
      <td>${totalCalls}</td>
      <td>$${trace.totalCostUsd.toFixed(4)}</td>
      <td></td>
    </tr>
  </tbody>
</table>`;
}

function buildHtml(trace: OrchestratorTrace): string {
  const ts = new Date(trace.startedAt).toLocaleString();

  const detailSections = trace.agentRuns.map((run, i) => {
    const runCost = run.totalCostUsd;
    const model = run.turns[0]?.model ?? "claude-sonnet-4-6";
    const n = run.turns.length;
    const color = TYPE_COLORS[run.type] ?? "var(--accent)";
    const meta = `${n} call${n !== 1 ? "s" : ""} · ${esc(model)} · $${runCost.toFixed(4)} · ${fmtDuration(run.totalDurationMs)}`;
    const cards = run.turns.map((t, j) => callCard(t, runCost, run.prompt, j === 0 ? run.tools : [])).join("");
    return `<div class="context-section" id="run-${i}">
  <h3>${esc(run.name)} <span class="type-badge" style="color:${color}">${esc(run.type)}</span></h3>
  <div class="context-meta">${meta}</div>
  ${costBreakdown(run.turns)}
  <div class="task-desc">${esc(run.prompt)}</div>
  ${cards}
</div>`;
  }).join("");

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trace v2 — ${esc(trace.connector)} — ${esc(trace.runId)}</title>
<style>${CSS}</style>
</head><body>
<header>
  <h1>Trace</h1>
  <span class="run-meta">${esc(trace.connector)} · ${esc(trace.months)}mo</span>
  <span class="run-meta">${esc(trace.runId.slice(0, 8))}</span>
  <span class="run-meta">${esc(ts)}</span>
  <span class="run-meta">$${trace.totalCostUsd.toFixed(4)} · ${fmtDuration(trace.totalDurationMs)}</span>
</header>
<main>
  <div class="section"><h2>Summary</h2>${summaryTable(trace)}</div>
  <div class="section"><h2>Agent Calls (chronological)</h2>${detailSections}</div>
</main>
<script>${JS}</script>
</body></html>`;
}
