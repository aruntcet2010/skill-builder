/**
 * Generate Claude Code skills from historical Zendesk tickets.
 * Pure TypeScript orchestrator — all LLM work delegated to focused agents.
 *
 * Usage:
 *   npx tsx generate_connector_skills.ts                          # all connectors
 *   npx tsx generate_connector_skills.ts --connector hubspot      # one connector
 *   npx tsx generate_connector_skills.ts --months 3               # last 3 months
 */

import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { runBatchAnalyzer } from "../agents/batch_analyzer.js";
import { runConsolidator } from "../agents/consolidator.js";
import { runIssueWriter } from "../agents/issue_writer.js";
import type { Symptom } from "../agents/types.js";
import { OrchestratorTracer } from "./tracer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ID = randomUUID();
const SKILL_DIR = path.join(REPO_ROOT, "generated", RUN_ID, "connector-oncall");

const ALL_CONNECTORS = [
  "hubspot",
  "zendesk",
  "oracle",
  "dynamodb",
  "shopify",
  "salesforce",
  "mssql",
  "mysql",
  "mongodb",
  "postgresql",
];

const otelEnv: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_LOG_RAW_API_BODIES: `file:/tmp/otel_bodies_${RUN_ID}`,
  ...process.env as Record<string, string>,
};

// ---------------------------------------------------------------------------
// Step 1: fetch tickets from Snowflake
// ---------------------------------------------------------------------------
function fetchTickets(connector: string, months: number): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`  [${connector}] fetching tickets from Snowflake...`);
    const child = spawn("npx", [
      "tsx",
      path.join(REPO_ROOT, "scripts/fetch_raw_tickets.ts"),
      "--connector", connector,
      "--months", String(months),
      "--output", `/tmp/${connector}_tickets`,
    ], { stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`fetch_raw_tickets exited with code ${code}`))
    );
  });
}

// ---------------------------------------------------------------------------
// Step 2: read metadata, return batches of ticket paths
// ---------------------------------------------------------------------------
async function readAndBatch(connector: string, batchSize = 50): Promise<string[][]> {
  const metadata = await fs.readFile(`/tmp/${connector}_tickets/metadata.md`, "utf8");
  const filenames: string[] = [];
  for (const line of metadata.split("\n")) {
    const match = line.match(/\|\s*\[(\S+\.md)\]/);
    if (match) filenames.push(match[1]);
  }
  const base = `/tmp/${connector}_tickets`;
  const paths = filenames.map(f => path.join(base, f));
  const batches: string[][] = [];
  for (let i = 0; i < paths.length; i += batchSize) {
    batches.push(paths.slice(i, i + batchSize));
  }
  console.log(`  [${connector}] ${paths.length} tickets → ${batches.length} batches`);
  return batches;
}

// ---------------------------------------------------------------------------
// Step 3: run batch analyzers in parallel, write batch JSON files
// ---------------------------------------------------------------------------
async function analyzeBatches(connector: string, batches: string[][], tracer: OrchestratorTracer): Promise<string[]> {
  console.log(`  [${connector}] running ${batches.length} batch analyzers in parallel...`);
  const batchFilePaths = await Promise.all(
    batches.map(async (batch, i) => {
      const symptoms = await runBatchAnalyzer(batch, otelEnv, tracer, `batch_analyzer[${i}]`);
      const filePath = `/tmp/${connector}_batch_${i}.json`;
      await fs.writeFile(filePath, JSON.stringify(symptoms, null, 2), "utf8");
      console.log(`  [${connector}] batch ${i} done — ${symptoms.length} symptoms`);
      return filePath;
    })
  );
  return batchFilePaths;
}

// ---------------------------------------------------------------------------
// Step 4: consolidate — deduplicate, rank, assign slugs
// ---------------------------------------------------------------------------
async function consolidate(connector: string, batchFilePaths: string[], tracer: OrchestratorTracer): Promise<Symptom[]> {
  console.log(`  [${connector}] consolidating ${batchFilePaths.length} batch files...`);
  const outputPath = `/tmp/${connector}_symptoms.json`;
  const symptoms = await runConsolidator(connector, batchFilePaths, outputPath, otelEnv, tracer);
  console.log(`  [${connector}] consolidated → ${symptoms.length} distinct symptoms`);
  return symptoms;
}

// ---------------------------------------------------------------------------
// Step 5: write issue files in parallel — one agent per symptom
// ---------------------------------------------------------------------------
async function writeIssueFiles(connector: string, symptoms: Symptom[], tracer: OrchestratorTracer): Promise<void> {
  const connectorDir = path.join(SKILL_DIR, connector);
  await fs.mkdir(connectorDir, { recursive: true });

  console.log(`  [${connector}] writing ${symptoms.length} issue files in parallel...`);
  await Promise.all(
    symptoms.map(async (symptom) => {
      const ticketPaths = symptom.ticket_ids.map(
        id => `/tmp/${connector}_tickets/ticket_${id}.md`
      );
      const outputPath = path.join(connectorDir, `${symptom.slug}.md`);
      await runIssueWriter(symptom, ticketPaths, outputPath, otelEnv, tracer);
      console.log(`  [${connector}] wrote ${symptom.slug}.md`);
    })
  );
}

// ---------------------------------------------------------------------------
// Step 6: write selection.md — pure TypeScript, no LLM
// ---------------------------------------------------------------------------
async function writeSelectionMd(
  connector: string,
  symptoms: Symptom[],
  totalTickets: number,
  months: number,
): Promise<void> {
  const connectorDir = path.join(SKILL_DIR, connector);
  const cap = connector.charAt(0).toUpperCase() + connector.slice(1);

  const mappingLines = symptoms.flatMap(s =>
    s.keywords.map(kw => `→ **"${kw}"** → [${s.title}](${s.slug}.md)`)
  ).join("\n");

  const tableRows = symptoms
    .map(s => `| ${s.title} | ${s.severity} | ${s.ticket_ids.length} | [${s.slug}.md](${s.slug}.md) |`)
    .join("\n");

  const content = `# ${cap} — Issue Index

**${totalTickets} tickets → ${symptoms.length} distinct symptoms** (last ${months} month(s))

## Symptom → Issue Mapping

${mappingLines}

## All Issues (most frequent first)

| Title | Severity | Tickets | File |
|-------|----------|---------|------|
${tableRows}
`;

  await fs.writeFile(path.join(connectorDir, "selection.md"), content, "utf8");
  console.log(`  [${connector}] wrote selection.md`);
}

// ---------------------------------------------------------------------------
// Top-level SKILL.md
// ---------------------------------------------------------------------------
async function writeSkillMd(connectors: string[], months: number): Promise<void> {
  await fs.mkdir(SKILL_DIR, { recursive: true });
  const rows = connectors
    .map(c => `| ${c.charAt(0).toUpperCase() + c.slice(1)} | [${c}/selection.md](${c}/selection.md) |`)
    .join("\n");

  const content = `---
name: connector-oncall
description: Historical oncall patterns from Zendesk support tickets (last ${months} month(s)) for all connectors. Use when debugging any connector pipeline issue, investigating customer-reported errors, or looking up past resolutions and root causes.
---

# Connector Oncall Patterns

Historical issue patterns extracted from Zendesk support tickets (last ${months} month(s)).

## Connectors

| Connector | Issue Index |
|-----------|-------------|
${rows}

## How to Use

1. Find your connector in the table above
2. Read \`{connector}/selection.md\` — maps symptoms and error keywords to specific issues
3. Read the linked \`{slug}.md\` — full root causes, resolutions, and related tickets
`;

  await fs.writeFile(path.join(SKILL_DIR, "SKILL.md"), content, "utf8");
  console.log(`Written SKILL.md → ${SKILL_DIR}/SKILL.md`);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
async function runConnector(connector: string, months: number): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Connector: ${connector} (last ${months} month(s))`);
  console.log("=".repeat(60));

  const connectorDir = path.join(SKILL_DIR, connector);
  const tracer = new OrchestratorTracer(`${connector} · ${months}mo`, RUN_ID, connectorDir);
  console.log(`  [${connector}] trace → ${path.join(connectorDir, "trace.html")} (updates as agents complete)`);

  // Step 1
  await fetchTickets(connector, months);

  // Step 2
  const batches = await readAndBatch(connector);
  if (batches.length === 0) {
    await fs.mkdir(connectorDir, { recursive: true });
    await fs.writeFile(
      path.join(connectorDir, "selection.md"),
      `No tickets found in the last ${months} month(s).`,
      "utf8"
    );
    return;
  }

  // Step 3
  const batchFilePaths = await analyzeBatches(connector, batches, tracer);

  // Step 4
  const symptoms = await consolidate(connector, batchFilePaths, tracer);

  // Step 5
  await writeIssueFiles(connector, symptoms, tracer);

  // Step 6
  const totalTickets = batches.flat().length;
  await writeSelectionMd(connector, symptoms, totalTickets, months);

  // Write trace
  await tracer.loadBodies();
  await tracer.writeReport(connectorDir);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const connectorFlag = args.indexOf("--connector");
  const connectors = connectorFlag !== -1 ? [args[connectorFlag + 1]] : ALL_CONNECTORS;

  const monthsFlag = args.indexOf("--months");
  const months = monthsFlag !== -1 ? parseInt(args[monthsFlag + 1], 10) : 6;

  console.log(`Generating skills for: ${connectors.join(", ")} (last ${months} month(s))`);
  console.log(`Run ID: ${RUN_ID}`);
  console.log(`Output: ${SKILL_DIR}/`);

  const completed: string[] = [];
  for (const connector of connectors) {
    if (!ALL_CONNECTORS.includes(connector)) {
      console.error(`Unknown connector: ${connector}. Valid: ${ALL_CONNECTORS.join(", ")}`);
      process.exit(1);
    }
    await runConnector(connector, months);
    completed.push(connector);
  }

  await writeSkillMd(completed, months);
  console.log("\nAll done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
