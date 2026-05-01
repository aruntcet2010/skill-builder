#!/usr/bin/env npx tsx
/**
 * Usage: npx tsx jira-tickets/generate_skills.ts <connector> <months> <output_file>
 * Example: npx tsx jira-tickets/generate_skills.ts MYSQL 3 output/mysql_tickets.json
 *
 * 1. Fetches matching ticket IDs via scripts/fetch-jira-tickets.ts → <output_file without .json>-raw.json
 * 2. Divides IDs into batches of 5; each batch fetches full ticket details from Jira (description + comments)
 * 3. Spawns Claude agents in parallel to bucketize each batch into issue types
 * 4. Merges results → output_file as { issue_types: [{ issue_type, ticketIds }] }
 * 5. Spawns one deep-analysis agent per issue type → <output_file without .json>-analysis/<issue-type>.json
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { runBatchBucketizer } from "./agents/batch_bucketizer.js";
import { runMerger } from "./agents/merger.js";
import { runDeepAnalyzer } from "./agents/deep_analyzer.js";
import type { FullTicket, IssueTypeBucket } from "./agents/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BATCH_SIZE = 5;

function loadEnv(): void {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
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

function parseArgs(): { connector: string; months: number; outputFile: string } {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error("Usage: npx tsx jira-tickets/generate_skills.ts <connector> <months> <output_file>");
    console.error("Example: npx tsx jira-tickets/generate_skills.ts MYSQL 3 output/mysql_tickets.json");
    process.exit(1);
  }
  const connector = args[0].toUpperCase();
  const months = parseInt(args[1], 10);
  if (isNaN(months) || months <= 0) {
    console.error(`Invalid months: "${args[1]}" — must be a positive integer`);
    process.exit(1);
  }
  return { connector, months, outputFile: args[2] };
}

function validateConnector(connector: string): void {
  const sourceGroupsPath = path.join(__dirname, "scripts", "source_groups.json");
  const sourceGroups: Record<string, string[]> = JSON.parse(
    fs.readFileSync(sourceGroupsPath, "utf-8")
  );
  if (!sourceGroups[connector]) {
    const available = Object.keys(sourceGroups).sort().join(", ");
    console.error(`Unknown connector: "${connector}"`);
    console.error(`Available connectors:\n  ${available}`);
    process.exit(1);
  }
}

function fetchTicketIds(connector: string, months: number, rawFile: string): string[] {
  const fetchScript = path.join(__dirname, "scripts", "fetch-jira-tickets.ts");
  const result = spawnSync(
    "npx",
    ["tsx", fetchScript, String(months), connector, rawFile],
    { stdio: "inherit", env: process.env }
  );
  if (result.error) {
    console.error("Failed to run fetch-jira-tickets.ts:", result.error.message);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  const data = JSON.parse(fs.readFileSync(rawFile, "utf-8")) as { ticketIds: string[] };
  return data.ticketIds;
}

// Recursively extract plain text from Atlassian Document Format (ADF)
function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;
  if (n.type === "text") return (n.text as string) ?? "";
  if (!Array.isArray(n.content)) return "";
  const children = (n.content as unknown[]).map(adfToText).join("");
  const block = new Set(["paragraph", "heading", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock"]);
  return block.has(n.type as string) ? children + "\n" : children;
}

async function fetchFullTicket(baseUrl: string, auth: string, key: string): Promise<FullTicket> {
  const fields = ["summary", "status", "priority", "description", "comment", "customfield_10209"].join(",");
  const response = await fetch(`${baseUrl}/rest/api/3/issue/${key}?fields=${fields}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Jira API ${response.status} for ${key}: ${await response.text()}`);
  }
  const issue = await response.json() as {
    key: string;
    fields: {
      summary: string;
      status: { name: string };
      priority: { name: string } | null;
      description: unknown;
      comment: { comments: { author: { displayName: string }; body: unknown; created: string }[] } | null;
      customfield_10209: { value: string } | null;
    };
  };

  return {
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    priority: issue.fields.priority?.name ?? "None",
    customerImpact: issue.fields.customfield_10209?.value ?? null,
    description: adfToText(issue.fields.description).trim(),
    comments: (issue.fields.comment?.comments ?? []).map((c) => ({
      author: c.author.displayName,
      body: adfToText(c.body).trim(),
      created: c.created,
    })),
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function bucketizeBatch(
  keys: string[],
  baseUrl: string,
  auth: string,
  batchIdx: number,
  totalBatches: number,
  batchFile: string,
): Promise<IssueTypeBucket[]> {
  process.stderr.write(`  Batch ${batchIdx}/${totalBatches}: fetching full details for ${keys.join(", ")}...\n`);
  const tickets = await Promise.all(keys.map((k) => fetchFullTicket(baseUrl, auth, k)));
  return runBatchBucketizer(tickets, batchIdx, totalBatches, batchFile);
}

async function analyzeAllIssueTypes(outputFile: string, baseUrl: string, auth: string): Promise<void> {
  const merged = JSON.parse(fs.readFileSync(outputFile, "utf-8")) as IssueTypeBucket[];
  const analysisDir = outputFile.replace(/\.json$/, "-analysis");

  process.stderr.write(`\nRunning deep-analysis agents for ${merged.length} issue types → ${analysisDir}/\n`);

  await Promise.all(
    merged.map(async (bucket) => {
      const allTicketIds = bucket.causes_with_tickets.flatMap((c) => c.ticket_ids);
      const tickets = await Promise.all(allTicketIds.map((k) => fetchFullTicket(baseUrl, auth, k)));
      const outPath = path.join(analysisDir, `${slugify(bucket.issue_type)}.json`);
      return runDeepAnalyzer(bucket, tickets, outPath);
    })
  );

  process.stderr.write(`\nDeep analysis complete. Files in ${path.resolve(analysisDir)}/\n`);
}

async function main(): Promise<void> {
  const { connector, months, outputFile } = parseArgs();
  validateConnector(connector);

  const rawFile = outputFile.replace(/\.json$/, "-raw.json");

  console.error(`Connector    : ${connector}`);
  console.error(`Months       : ${months}`);
  console.error(`Ticket IDs   : ${path.resolve(rawFile)}`);
  console.error(`Output file  : ${path.resolve(outputFile)}`);
  console.error("");

  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "") ?? "";
  const email = process.env.JIRA_EMAIL ?? "";
  const apiToken = process.env.JIRA_API_TOKEN ?? "";
  if (!baseUrl || !email || !apiToken) {
    console.error("Missing required env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
    process.exit(1);
  }
  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

  // Step 1: fetch ticket IDs
  const ticketIds = fetchTicketIds(connector, months, rawFile);

  console.error(`\nBucketizing ${ticketIds.length} tickets in batches of ${BATCH_SIZE}...`);

  // Step 2: split into batches, fetch full details + run agents in parallel
  const batches: string[][] = [];
  for (let i = 0; i < ticketIds.length; i += BATCH_SIZE) {
    batches.push(ticketIds.slice(i, i + BATCH_SIZE));
  }

  const batchFiles = batches.map((_, idx) =>
    outputFile.replace(/\.json$/, `-batch-${String(idx + 1).padStart(2, "0")}.json`)
  );

  await Promise.all(
    batches.map((batch, idx) =>
      bucketizeBatch(batch, baseUrl, auth, idx + 1, batches.length, batchFiles[idx])
    )
  );

  // Step 3: merge all batch files with an agent
  await runMerger(batchFiles, outputFile);

  // Step 4: spawn one deep-analysis agent per issue type
  await analyzeAllIssueTypes(outputFile, baseUrl, auth);
}

main().catch((err) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});
