#!/usr/bin/env npx tsx
/**
 * Usage: npx tsx jira-tickets/scripts/fetch-jira-tickets.ts <months> <source_group> <output_file>
 * Example: npx tsx jira-tickets/scripts/fetch-jira-tickets.ts 3 MYSQL output/mysql-tickets.json
 *
 * Reads vars from .env in the project root (falls back to environment):
 *   JIRA_BASE_URL   e.g. https://hevodata.atlassian.net
 *   JIRA_EMAIL      e.g. talha@hevodata.com
 *   JIRA_API_TOKEN  Atlassian API token
 *   JIRA_PROJECT    e.g. HEVO (optional, scopes search to a specific project)
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

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

function parseArgs(): { months: number; sourceGroup: string; outputFile: string } {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error("Usage: npx tsx jira-tickets/scripts/fetch-jira-tickets.ts <months> <source_group> <output_file>");
    console.error("Example: npx tsx jira-tickets/scripts/fetch-jira-tickets.ts 3 MYSQL output/mysql-tickets.json");
    process.exit(1);
  }

  const months = parseInt(args[0], 10);
  if (isNaN(months) || months <= 0) {
    console.error(`Invalid months: "${args[0]}" — must be a positive integer`);
    process.exit(1);
  }

  return { months, sourceGroup: args[1].toUpperCase(), outputFile: args[2] };
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
  issues: JiraIssue[],
  sourceGroup: string,
  sourceTypes: string[],
  months: number,
  fromDate: string,
  outputFile: string
): void {
  const output = {
    query: {
      sourceGroup,
      sourceTypes,
      months,
      fromDate,
      fetchedAt: new Date().toISOString(),
    },
    total: issues.length,
    ticketIds: issues.map((issue) => issue.key),
  };

  const absPath = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(output, null, 2), "utf-8");
  process.stderr.write(`Written to ${absPath}\n`);
}

async function main(): Promise<void> {
  const { months, sourceGroup, outputFile } = parseArgs();

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
  process.stderr.write(`JQL          : ${jql}\n\n`);

  const issues = await fetchAllTickets(baseUrl, auth, jql);
  writeOutput(issues, sourceGroup, sourceTypes, months, fromDateStr, outputFile);
}

main().catch((err) => {
  console.error("Error:", (err as Error).message);
  process.exit(1);
});