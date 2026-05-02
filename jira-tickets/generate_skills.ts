#!/usr/bin/env npx tsx
/**
 * Generate Claude Code skills from historical Hevo OnCall Jira tickets.
 *
 * Usage:
 *   npx tsx jira-tickets/generate_skills.ts                              # all connectors, last 3 months
 *   npx tsx jira-tickets/generate_skills.ts --connectors mysql,postgres  # specific
 *   npx tsx jira-tickets/generate_skills.ts --months 6                   # last 6 months
 *
 * Output tree:
 *   generated/<RUN_ID>/jira-tickets/
 *   ├── SKILL.md                      (top-level skill, lists every connector)
 *   ├── selection.md                  (cross-connector symptom → file index)
 *   └── <connector>/
 *       ├── <slug>.md × N             (one per issue type)
 *       └── trace.html                (live OTLP trace)
 *
 * Intermediate artifacts:
 *   /tmp/<RUN_ID>/<connector>/
 *   ├── raw/ticket_<KEY>.md           (one md per ticket — full description + comments)
 *   ├── batch_<n>.json                (bucketized output of one batch)
 *   ├── dedup.json                    (deduplicated buckets across batches)
 *   └── <slug>.json                   (per-issue-type deep analysis)
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { runBatchBucketizer } from "./agents/batch_bucketizer.js";
import { runDeduplicator } from "./agents/deduplicator.js";
import { runDeepAnalyzer } from "./agents/deep_analyzer.js";
import { fetchFullTicket } from "./scripts/fetch-jira-tickets.js";
import { formatTicketAsMarkdown, type IssueTypeBucket } from "./agents/types.js";
import { OrchestratorTracer } from "../lib/tracer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RUN_ID = randomUUID();
const GENERATED_DIR = path.join(REPO_ROOT, "generated", RUN_ID, "jira-tickets");

const BATCH_SIZE = 5;
const DEFAULT_MONTHS = 3;

interface DeepAnalysis {
  issue_type: string;
  symptoms: string[];
  causes: { cause: string; ticket_ids: string[]; explanation: string }[];
  all_ticket_ids: string[];
  patterns: string;
}

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------
function loadEnv(): void {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadAllConnectors(): string[] {
  const sourceGroupsPath = path.join(__dirname, "scripts", "source_groups.json");
  const sourceGroups: Record<string, string[]> = JSON.parse(
    fs.readFileSync(sourceGroupsPath, "utf-8")
  );
  return Object.keys(sourceGroups);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Step 1: fetch ticket IDs (spawns scripts/fetch-jira-tickets.ts)
// ---------------------------------------------------------------------------
function fetchTicketIds(sourceGroup: string, months: number, idsFile: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const fetchScript = path.join(__dirname, "scripts", "fetch-jira-tickets.ts");
    const child = spawn(
      "npx",
      ["tsx", fetchScript, String(months), sourceGroup, idsFile],
      { stdio: "inherit", env: process.env }
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`fetch-jira-tickets.ts exited with code ${code} for ${sourceGroup}`));
        return;
      }
      try {
        const data = JSON.parse(fs.readFileSync(idsFile, "utf-8")) as { ticketIds: string[] };
        resolve(data.ticketIds);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Step 2: fetch full details for every ticket and write one md per ticket
// ---------------------------------------------------------------------------
async function writeRawTicketFiles(
  ticketIds: string[],
  baseUrl: string,
  auth: string,
  rawDir: string,
  connector: string,
): Promise<string[]> {
  fs.mkdirSync(rawDir, { recursive: true });
  process.stderr.write(`  [${connector}] fetching full details for ${ticketIds.length} tickets...\n`);
  const filePaths = await Promise.all(ticketIds.map(async (key) => {
    const ticket = await fetchFullTicket(baseUrl, auth, key);
    const filePath = path.join(rawDir, `ticket_${key}.md`);
    fs.writeFileSync(filePath, formatTicketAsMarkdown(ticket), "utf-8");
    return filePath;
  }));
  process.stderr.write(`  [${connector}] wrote ${filePaths.length} ticket files → ${rawDir}/\n`);
  return filePaths;
}

// ---------------------------------------------------------------------------
// Step 6: TS rendering — per-issue markdown + selection.md + per-connector SKILL.md
// ---------------------------------------------------------------------------
interface RenderedIssue {
  slug: string;
  bucket: IssueTypeBucket;
  analysis: DeepAnalysis | null;
}

interface ConnectorResult {
  connector: string;
  ok: boolean;
  totalTickets: number;
  rendered: RenderedIssue[];
}

function writeGlobalSelectionMd(
  rootDir: string,
  months: number,
  results: ConnectorResult[],
): void {
  const successful = results.filter((r) => r.ok && r.rendered.length > 0);

  const symptomLines = successful.flatMap((r) =>
    r.rendered.flatMap(({ slug, bucket, analysis }) => {
      const symptoms = analysis?.symptoms ?? [];
      return symptoms.map(
        (s) => `→ **"${s}"** → [${titleCase(r.connector)} · ${bucket.issue_type}](${r.connector}/${slug}.md)`,
      );
    })
  );
  const mappingBlock = symptomLines.length ? symptomLines.join("\n") : "_No symptom mapping available._";

  const tableRows = successful
    .flatMap((r) =>
      r.rendered.map(({ slug, bucket }) => ({
        connector: r.connector,
        slug,
        issueType: bucket.issue_type,
        count: bucket.causes_with_tickets.flatMap((c) => c.ticket_ids).length,
      }))
    )
    .sort((a, b) => b.count - a.count)
    .map(
      ({ connector, slug, issueType, count }) =>
        `| ${titleCase(connector)} | ${issueType} | ${count} | [${connector}/${slug}.md](${connector}/${slug}.md) |`,
    )
    .join("\n");

  const totalTickets = successful.reduce((s, r) => s + r.totalTickets, 0);
  const totalIssues = successful.reduce((s, r) => s + r.rendered.length, 0);

  const content = `# Hevo Connector Oncall — Issue Index

**${totalTickets} tickets → ${totalIssues} issue types across ${successful.length} connector(s)** (last ${months} month(s))

## Symptom → Issue Mapping

${mappingBlock}

## All Issues (most frequent first)

| Connector | Issue Type | Tickets | File |
|-----------|------------|---------|------|
${tableRows}
`;

  fs.writeFileSync(path.join(rootDir, "selection.md"), content, "utf-8");
  process.stderr.write(`Wrote selection.md → ${path.join(rootDir, "selection.md")}\n`);
}

function writeGlobalSkillMd(rootDir: string, months: number, results: ConnectorResult[]): void {
  const successful = results.filter((r) => r.ok && r.rendered.length > 0);
  const connectorRows = successful
    .map((r) => `| ${titleCase(r.connector)} | ${r.totalTickets} | ${r.rendered.length} |`)
    .join("\n");

  const content = `---
name: connector-oncall-jira
description: Historical oncall patterns from Hevo Jira oncall tickets across all connectors (last ${months} month(s)). Use when debugging a connector pipeline issue, investigating a customer-reported error, or looking up past root causes and resolutions.
---

# Connector Oncall Patterns (Jira)

Historical issue patterns extracted from Hevo OnCall Jira tickets (last ${months} month(s)).

## Connectors

| Connector | Tickets | Issue Types |
|-----------|---------|-------------|
${connectorRows}

## How to Use

1. Read \`selection.md\` — maps customer symptoms to specific issue types across all connectors
2. Read the linked \`<connector>/<slug>.md\` — root causes, patterns, and the tickets behind it
`;

  fs.writeFileSync(path.join(rootDir, "SKILL.md"), content, "utf-8");
  process.stderr.write(`Wrote SKILL.md → ${path.join(rootDir, "SKILL.md")}\n`);
}

// ---------------------------------------------------------------------------
// Per-connector pipeline
// ---------------------------------------------------------------------------
async function runConnector(
  rawConnector: string,
  months: number,
  baseUrl: string,
  auth: string,
): Promise<ConnectorResult> {
  const upper = rawConnector.toUpperCase();
  const connector = rawConnector.toLowerCase();

  const tmpDir = path.join("/tmp", RUN_ID, connector);
  const rawDir = path.join(tmpDir, "raw");
  const skillDir = path.join(GENERATED_DIR, connector);

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  process.stderr.write(`  [${connector}] tmp=${tmpDir} skill=${skillDir}\n`);

  const tracer = new OrchestratorTracer(`${connector} · ${months}mo`, RUN_ID);
  const traceHtmlPath = path.join(skillDir, "trace.html");
  tracer.startLiveReport(traceHtmlPath);
  process.stderr.write(`  [${connector}] OTLP receiver on port ${tracer.port}\n`);

  try {
    // Step 1: ticket IDs
    const idsFile = path.join(tmpDir, "ids.json");
    const ticketIds = await fetchTicketIds(upper, months, idsFile);
    process.stderr.write(`  [${connector}] ${ticketIds.length} ticket IDs\n`);

    if (ticketIds.length === 0) {
      process.stderr.write(`  [${connector}] no tickets in last ${months} month(s) — skipping\n`);
      return { connector, ok: true, totalTickets: 0, rendered: [] };
    }

    // Step 2: full ticket details → one md per ticket
    const ticketFiles = await writeRawTicketFiles(ticketIds, baseUrl, auth, rawDir, connector);

    // Step 3: bucketize batches in parallel
    const batches: string[][] = [];
    for (let i = 0; i < ticketFiles.length; i += BATCH_SIZE) {
      batches.push(ticketFiles.slice(i, i + BATCH_SIZE));
    }
    const batchJsonPaths = batches.map((_, idx) =>
      path.join(tmpDir, `batch_${String(idx + 1).padStart(2, "0")}.json`)
    );
    await Promise.all(
      batches.map((batchFiles, idx) => {
        const env = tracer.getAgentEnv(`batch_bucketizer[${idx + 1}]`, "batch_bucketizer");
        return runBatchBucketizer(batchFiles, batchJsonPaths[idx], idx + 1, batches.length, env);
      })
    );

    // Step 4: deduplicate across batches
    const dedupJsonPath = path.join(tmpDir, "dedup.json");
    const dedupEnv = tracer.getAgentEnv("deduplicator", "deduplicator");
    await runDeduplicator(batchJsonPaths, dedupJsonPath, dedupEnv);
    const buckets = JSON.parse(fs.readFileSync(dedupJsonPath, "utf-8")) as IssueTypeBucket[];

    // Step 5: deep analyze each issue type in parallel — agent writes BOTH the
    // structured JSON (in /tmp) and the user-facing markdown (in skillDir).
    const rendered: RenderedIssue[] = await Promise.all(buckets.map(async (bucket) => {
      const slug = slugify(bucket.issue_type);
      const ticketIdsForIssue = bucket.causes_with_tickets.flatMap((c) => c.ticket_ids);
      const analysisJsonPath = path.join(tmpDir, `${slug}.json`);
      const mdPath = path.join(skillDir, `${slug}.md`);
      const env = tracer.getAgentEnv(`deep_analyzer[${slug}]`, "deep_analyzer");
      await runDeepAnalyzer(
        bucket.issue_type,
        titleCase(connector),
        ticketIdsForIssue,
        dedupJsonPath,
        rawDir,
        analysisJsonPath,
        mdPath,
        env,
      );

      let analysis: DeepAnalysis | null = null;
      if (fs.existsSync(analysisJsonPath)) {
        try {
          analysis = JSON.parse(fs.readFileSync(analysisJsonPath, "utf-8")) as DeepAnalysis;
        } catch {
          analysis = null;
        }
      }
      process.stderr.write(`  [${connector}] ${slug}.md ${fs.existsSync(mdPath) ? "ok" : "MISSING"}\n`);
      return { slug, bucket, analysis };
    }));

    return { connector, ok: true, totalTickets: ticketIds.length, rendered };
  } catch (err) {
    process.stderr.write(`  [${connector}] FAILED: ${(err as Error).message}\n`);
    return { connector, ok: false, totalTickets: 0, rendered: [] };
  } finally {
    await tracer.writeReport(skillDir);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const allConnectors = loadAllConnectors();
  const allLower = allConnectors.map((c) => c.toLowerCase());

  const connectorsFlag = args.indexOf("--connectors");
  const requested = connectorsFlag !== -1
    ? args[connectorsFlag + 1].split(",").map((c) => c.trim().toLowerCase())
    : allLower;

  for (const c of requested) {
    if (!allLower.includes(c)) {
      console.error(`Unknown connector: "${c}"`);
      console.error(`Available: ${allLower.join(", ")}`);
      process.exit(1);
    }
  }

  const monthsFlag = args.indexOf("--months");
  const months = monthsFlag !== -1 ? parseInt(args[monthsFlag + 1], 10) : DEFAULT_MONTHS;
  if (isNaN(months) || months <= 0) {
    console.error(`Invalid months: must be a positive integer`);
    process.exit(1);
  }

  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "") ?? "";
  const email = process.env.JIRA_EMAIL ?? "";
  const apiToken = process.env.JIRA_API_TOKEN ?? "";
  if (!baseUrl || !email || !apiToken) {
    console.error("Missing required env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
    process.exit(1);
  }
  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

  console.error(`Run ID    : ${RUN_ID}`);
  console.error(`Connectors: ${requested.join(", ")}`);
  console.error(`Months    : ${months}`);
  console.error(`Skill dir : ${GENERATED_DIR}/<connector>/`);
  console.error(`Tmp dir   : /tmp/${RUN_ID}/<connector>/`);
  console.error("");

  const results = await Promise.all(
    requested.map((c) => runConnector(c, months, baseUrl, auth))
  );

  const completed = results.filter((r) => r.ok).map((r) => r.connector);
  const failed = results.filter((r) => !r.ok).map((r) => r.connector);

  // Top-level index files spanning all completed connectors.
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  writeGlobalSelectionMd(GENERATED_DIR, months, results);
  writeGlobalSkillMd(GENERATED_DIR, months, results);

  if (failed.length > 0) {
    console.error(`\nFailed connectors: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.error(`\nAll done. Generated skills for: ${completed.join(", ")}`);
}

main().catch((err) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
