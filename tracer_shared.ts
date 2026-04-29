/**
 * Shared rendering primitives used by both tracer.ts (v1) and tracer_v2.ts.
 */

// ── Pricing ───────────────────────────────────────────────────────────────────
export const PRICING: Record<string, [number, number, number]> = {
  "claude-sonnet-4-6":         [3.00,  0.30,  15.00],
  "claude-sonnet-4-5":         [3.00,  0.30,  15.00],
  "claude-opus-4-6":           [15.00, 1.50,  75.00],
  "claude-haiku-4-5":          [0.80,  0.08,   4.00],
  "claude-haiku-4-5-20251001": [0.80,  0.08,   4.00],
};
export const DEFAULT_PRICING: [number, number, number] = [3.00, 0.30, 15.00];

export function calcCost(model: string, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  const [ip, cp, op] = PRICING[model] ?? DEFAULT_PRICING;
  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  return (uncached / 1e6) * ip + (cacheRead / 1e6) * cp + (cacheWrite / 1e6) * ip * 1.25 + (output / 1e6) * op;
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description?: string;
  type: "builtin" | "subagent";
  model?: string;
  tools?: string[];
}

export interface ApiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Turn {
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

// ── CSS / JS ──────────────────────────────────────────────────────────────────
export const CSS = `
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
.summary-table tr.group-header td { font-size: 11px; color: var(--text-dim); background: var(--surface); padding: 4px 12px; }
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
.type-badge { font-size: 10px; color: var(--text-dim); background: var(--surface2); border-radius: 3px; padding: 1px 6px; margin-left: 8px; font-family: var(--mono); vertical-align: middle; }
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

export const JS = `
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

// ── Rendering helpers ─────────────────────────────────────────────────────────
export function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

export function costBar(cost: number, total: number): string {
  const pct = total ? Math.min(100, (cost / total) * 100) : 0;
  const color = pct < 5 ? "var(--green)" : pct < 15 ? "var(--amber)" : "var(--red)";
  return `<div class="bar-wrap"><div class="bar" style="width:${pct.toFixed(1)}%;background:${color}" title="$${cost.toFixed(4)}"></div></div>`;
}

export function toolPills(toolUses: ToolUse[]): string {
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

export function toolBlock(t: ToolUse): string {
  const argsStr = JSON.stringify(t.input, null, 2);
  const agentNote = t.name === "Agent"
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

export function costBreakdown(turns: Turn[]): string {
  let inputCost = 0, cacheReadCost = 0, cacheWriteCost = 0, outputCost = 0;
  for (const t of turns) {
    const [ip, cp, op] = PRICING[t.model] ?? DEFAULT_PRICING;
    const uncached = Math.max(0, t.inputTokens - t.cacheReadTokens - t.cacheCreationTokens);
    inputCost      += (uncached / 1e6) * ip;
    cacheReadCost  += (t.cacheReadTokens / 1e6) * cp;
    cacheWriteCost += (t.cacheCreationTokens / 1e6) * ip * 1.25;
    outputCost     += (t.outputTokens / 1e6) * op;
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

export function availableToolsSection(tools: ToolDef[]): string {
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

export function callCard(turn: Turn, totalCost: number, prompt: string, tools: ToolDef[] = []): string {
  const totalIn = turn.inputTokens + turn.cacheReadTokens + turn.cacheCreationTokens;
  const tokenRow = `in=${totalIn.toLocaleString()} | out=${turn.outputTokens.toLocaleString()} | cache_read=${turn.cacheReadTokens.toLocaleString()} | cache_creation=${turn.cacheCreationTokens.toLocaleString()}`;
  const elapsed = `<span class="call-elapsed">@ ${fmtDuration(turn.elapsedMs)}</span>`;
  const thought = turn.text ? `<div class="thought">${esc(turn.text)}</div>` : "";
  const toolBlocks = turn.toolUses.map(toolBlock).join("");
  const promptSection = turn.seq === 1 && prompt
    ? `<details class="available-tools"><summary>Prompt</summary><div class="tools-list"><div class="tool-def-desc">${esc(prompt)}</div></div></details>`
    : "";
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
    ${promptSection}
  </div>
</div>`;
}
