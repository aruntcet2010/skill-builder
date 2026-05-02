#!/usr/bin/env npx tsx
/**
 * Usage: npx tsx jira-tickets/scripts/fetch-jira-tickets.ts <months> <source_group> <output_file> [--details]
 * Example: npx tsx jira-tickets/scripts/fetch-jira-tickets.ts 3 MYSQL output/mysql-tickets.json
 *
 * Without --details: writes { query, total, ticketIds }.
 * With    --details: also fetches description + comments for each ticket and writes
 *                    { query, total, tickets: FullTicket[] }.
 *
 * Reads vars from .env in the project root (falls back to environment):
 *   JIRA_BASE_URL   e.g. https://hevodata.atlassian.net
 *   JIRA_EMAIL      e.g. talha@hevodata.com
 *   JIRA_API_TOKEN  Atlassian API token
 *   JIRA_PROJECT    e.g. HEVO (optional, scopes search to a specific project)
 *
 * Also exports `adfToText` and `fetchFullTicket` for use as a library by agents
 * (e.g. batch_bucketizer.ts, generate_skills.ts).
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { FullTicket } from "../agents/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(): void {
  const envPath = path.join(__dirname, "..", "..", ".env");
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

type SourceGroups = Record<string, string[]>;

interface JiraFields {
  summary: string;
  status: { name: string };
  created: string;
  updated: string;
  priority: { name: string } | null;
  assignee: { displayName: string; emailAddress: string } | null;
  reporter: { displayName: string; emailAddress: string } | null;
  customfield_10209: { value: string } | null;
  issuetype: { name: string };
  description: unknown;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: JiraFields;
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------------------
// Library exports
// ---------------------------------------------------------------------------

export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;
  if (n.type === "text") return (n.text as string) ?? "";
  if (!Array.isArray(n.content)) return "";
  const children = (n.content as unknown[]).map(adfToText).join("");
  const block = new Set(["paragraph", "heading", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock"]);
  return block.has(n.type as string) ? children + "\n" : children;
}

export async function fetchFullTicket(baseUrl: string, auth: string, key: string): Promise<FullTicket> {
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): { months: number; sourceGroup: string; outputFile: string; details: boolean } {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));

  if (positional.length !== 3) {
    console.error("Usage: npx tsx jira-tickets/scripts/fetch-jira-tickets.ts <months> <source_group> <output_file> [--details]");
    console.error("Example: npx tsx jira-tickets/scripts/fetch-jira-tickets.ts 3 MYSQL output/mysql-tickets.json");
    process.exit(1);
  }

  const months = parseInt(positional[0], 10);
  if (isNaN(months) || months <= 0) {
    console.error(`Invalid months: "${positional[0]}" — must be a positive integer`);
    process.exit(1);
  }

  return {
    months,
    sourceGroup: positional[1].toUpperCase(),
    outputFile: positional[2],
    details: flags.has("--details"),
  };
}

function loadSourceGroups(): SourceGroups {
  const filePath = path.join(__dirname, "source_groups.json");
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SourceGroups;
}

function buildJql(sourceTypes: string[], fromDate: string, project?: string): string {
  const quotedTypes = sourceTypes.map((t) => `"${t}"`).join(", ");
  const typeFilter = `source in (${quotedTypes})`;

  const parts = [
    `created >= "${fromDate}"`,
    project ? `project = "${project}"` : null,
    typeFilter,
  ].filter(Boolean);

  return `${parts.join(" AND ")} ORDER BY created DESC`;
}

async function fetchPage(
  baseUrl: string,
  auth: string,
  jql: string,
  maxResults: number,
  nextPageToken?: string
): Promise<JiraSearchResponse> {
  const body: Record<string, unknown> = {
    jql,
    maxResults,
    fields: ["summary"],
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;

  const response = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira API ${response.status}: ${text}`);
  }

  return response.json() as Promise<JiraSearchResponse>;
}

async function fetchAllTickets(
  baseUrl: string,
  auth: string,
  jql: string
): Promise<JiraIssue[]> {
  const PAGE_SIZE = 100;
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  do {
    const page = await fetchPage(baseUrl, auth, jql, PAGE_SIZE, nextPageToken);
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken;

    process.stderr.write(`\rFetched ${issues.length} tickets...`);

    if (page.issues.length === 0) break;
  } while (nextPageToken);

  process.stderr.write("\n");
  return issues;
}

function writeOutput(
  payload: Record<string, unknown>,
  outputFile: string
): void {
  const absPath = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(payload, null, 2), "utf-8");
  process.stderr.write(`Written to ${absPath}\n`);
}

async function main(): Promise<void> {
  const { months, sourceGroup, outputFile, details } = parseArgs();

  const sourceGroups = loadSourceGroups();
  if (!sourceGroups[sourceGroup]) {
    const available = Object.keys(sourceGroups).sort().join(", ");
    console.error(`Unknown source group: "${sourceGroup}"`);
    console.error(`Available groups:\n  ${available}`);
    process.exit(1);
  }

  const sourceTypes = sourceGroups[sourceGroup];

  const fromDate = new Date();
  fromDate.setMonth(fromDate.getMonth() - months);
  const fromDateStr = fromDate.toISOString().split("T")[0];

  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  const project = process.env.JIRA_PROJECT;

  if (!baseUrl || !email || !apiToken) {
    console.error("Missing required env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
    process.exit(1);
  }

  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  const jql = buildJql(sourceTypes, fromDateStr, project);

  process.stderr.write(`Source group : ${sourceGroup}\n`);
  process.stderr.write(`Source types : ${sourceTypes.join(", ")}\n`);
  process.stderr.write(`Date range   : ${fromDateStr} → today\n`);
  if (project) process.stderr.write(`Project      : ${project}\n`);
  process.stderr.write(`Mode         : ${details ? "details" : "ids only"}\n`);
  process.stderr.write(`JQL          : ${jql}\n\n`);

  const issues = await fetchAllTickets(baseUrl, auth, jql);

  const query = {
    sourceGroup,
    sourceTypes,
    months,
    fromDate: fromDateStr,
    fetchedAt: new Date().toISOString(),
  };

  if (!details) {
    writeOutput(
      { query, total: issues.length, ticketIds: issues.map((i) => i.key) },
      outputFile,
    );
    return;
  }

  process.stderr.write(`Fetching full details for ${issues.length} tickets...\n`);
  const tickets = await Promise.all(issues.map((i) => fetchFullTicket(baseUrl, auth, i.key)));
  writeOutput({ query, total: tickets.length, tickets }, outputFile);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  });
}
