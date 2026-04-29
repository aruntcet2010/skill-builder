/**
 * Fetch raw Zendesk tickets from Snowflake for a given connector.
 * Filters to the last N months. Writes one markdown file per ticket
 * plus a metadata.md index, matching the signals-backend support_tickets.py format.
 *
 * Usage: npx tsx scripts/fetch_raw_tickets.ts --connector hubspot [--months 6] [--output /tmp/hubspot_tickets]
 */

import snowflake from "snowflake-sdk";
import fs from "fs/promises";
import path from "path";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(SCRIPTS_DIR, "../.env") });
snowflake.configure({ logLevel: "ERROR", logFilePath: path.join(SCRIPTS_DIR, "../logs/snowflake.log") } as any);

// ---------------------------------------------------------------------------
// Connector map
// ---------------------------------------------------------------------------
const CONNECTOR_MAP: Record<string, string> = {
  activecampaign: "activecampaign",
  adroll: "ad_roll",
  amazon_ads: "amazon_ads",
  amazon_rds_mysql: "amazon_rds_mysql_",
  amazon_s3: "amazon_s3",
  bigquery: "bigquery",
  chargebee: "chargebee",
  databricks: "databricks",
  dynamodb: "dynamo_db",
  elasticsearch: "elastic_search",
  facebook_ads: "fb_ads",
  freshdesk: "freshdesk_",
  ftp_sftp: "ftp_sftp",
  google_ads: "google_ads",
  google_analytics_4: "google_analytics_4_",
  google_sheets: "google_sheets",
  hubspot: "hub_spot",
  intercom: "intercom_",
  jira: "jira_",
  kafka: "kafka_",
  klaviyo: "klaviyo_",
  mailchimp: "mail_chimp",
  marketo: "marketo_",
  mongodb: "mongo_db",
  mssql: "ms_sql",
  mysql: "my_sql",
  netsuite: "netsuite",
  netsuite_erp: "netsuite_erp",
  oracle: "oracle_",
  postgresql: "postgres_sql",
  redshift: "redshift",
  rest_api: "rest_api",
  salesforce: "salesforce_",
  shopify: "shopify_",
  snowflake_connector: "snowflake",
  stripe: "stripe_",
  tiktok: "tiktok",
  webhooks: "web_hooks",
  zendesk: "zendesk_",
};

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
const SQL_PATH = path.join(SCRIPTS_DIR, "zendesk_tickets_by_connector.sql");

function adaptSql(rawSql: string): string {
  return rawSql
    .replace(/%%/g, "%")
    .replaceAll("%(connector_value)s", "?")
    .replace(
      "AND f.value['value']::VARCHAR = ?",
      "AND f.value['value']::VARCHAR = ?\n      AND t.CREATED_AT >= DATEADD(month, ?, CURRENT_DATE())"
    );
}

// ---------------------------------------------------------------------------
// Snowflake
// ---------------------------------------------------------------------------
async function createConnection(): Promise<snowflake.Connection> {
  const privateKeyPem = await fs.readFile(process.env.SNOWFLAKE_PRIVATE_KEY_PATH!, "utf8");
  return snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT!,
    username: process.env.SNOWFLAKE_USER!,
    authenticator: "SNOWFLAKE_JWT",
    privateKey: privateKeyPem,
    database: process.env.SNOWFLAKE_DATABASE ?? "HEVO_ANALYTICS",
    schema: process.env.SNOWFLAKE_SCHEMA ?? "RAW",
    warehouse: process.env.SNOWFLAKE_WAREHOUSE ?? "COMPUTE_WH",
  });
}

async function connect(conn: snowflake.Connection): Promise<void> {
  return new Promise((resolve, reject) =>
    conn.connect((err) => (err ? reject(err) : resolve()))
  );
}

async function fetchRows(
  conn: snowflake.Connection,
  sql: string,
  binds: snowflake.Binds
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) =>
    conn.execute({
      sqlText: sql,
      binds,
      complete: (err, _stmt, rows) => {
        if (err) return reject(err);
        resolve(
          (rows ?? []).map((row) =>
            Object.fromEntries(
              Object.entries(row as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v])
            )
          )
        );
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Markdown rendering — mirrors support_tickets.py
// ---------------------------------------------------------------------------

const METADATA_EXCLUDE = new Set([
  "ticket_description",       // rendered as ## Description
  "comments_json",            // rendered as ## Comments
  "ticket_id",                // in H1
  "ticket_title",             // in H1
  "ticket_url",
  "submitter_email",
  "submitter_is_agent",
  "ticket_account_id",
  "comment_count",            // derived from comments_json
]);

// Keys that are noisy internal identifiers
function isNoiseKey(key: string): boolean {
  return key.endsWith("_id") && key !== "ticket_id";
}

function humanise(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function cleanText(text: string): string {
  // Strip HTML tags, collapse whitespace
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseComments(ticket: Record<string, unknown>): Record<string, unknown>[] {
  const raw = ticket["comments_json"];
  if (!raw) return [];
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function renderComment(i: number, comment: Record<string, unknown>): string[] {
  const lines: string[] = [`#### Comment ${i}`];
  const blocks: string[][] = [];
  for (const [key, val] of Object.entries(comment)) {
    if (val == null || val === "" || isNoiseKey(key)) continue;
    const cleaned = cleanText(String(val)).slice(0, 3000);
    if (!cleaned) continue;
    const label = humanise(key);
    if (cleaned.includes("\n") || cleaned.length > 200) {
      blocks.push(["", `**${label}:**`, "", cleaned]);
    } else {
      lines.push(`- **${label}:** ${cleaned}`);
    }
  }
  for (const block of blocks) lines.push(...block);
  lines.push("");
  return lines;
}

function descriptionDuplicatesFirstComment(
  description: string,
  comments: Record<string, unknown>[]
): boolean {
  if (!description || comments.length === 0) return false;
  const normDesc = description.replace(/\s+/g, " ").trim();
  if (normDesc.length < 50) return false;
  for (const val of Object.values(comments[0])) {
    if (!val) continue;
    const body = cleanText(String(val));
    if (body.length < 50) continue;
    const normBody = body.replace(/\s+/g, " ").trim();
    const n = Math.min(normDesc.length, normBody.length, 200);
    if (n >= 50 && normDesc.slice(0, n) === normBody.slice(0, n)) return true;
  }
  return false;
}

interface TicketMeta {
  filename: string;
  tid: string | number;
  title: string;
  status: string;
  priority: string;
  commentCount: number;
  charCount: number;
  lineCount: number;
}

function writeTicketMarkdown(
  ticket: Record<string, unknown>,
  idx: number
): { content: string; filename: string; meta: TicketMeta } {
  const tid = ticket["ticket_id"] ?? `ticket_${idx}`;
  const filename = `ticket_${tid}.md`;
  const title = String(ticket["ticket_title"] ?? "(no title)");
  const comments = parseComments(ticket);
  const description = cleanText(String(ticket["ticket_description"] ?? "")).slice(0, 5000);
  const showDescription = Boolean(description) && !descriptionDuplicatesFirstComment(description, comments);

  const lines: string[] = [`# Ticket ${tid}: ${title}`, "", "## Metadata"];

  for (const [key, val] of Object.entries(ticket)) {
    if (METADATA_EXCLUDE.has(key) || isNoiseKey(key) || val == null || val === "") continue;
    const cleaned = cleanText(String(val)).slice(0, 500);
    if (!cleaned) continue;
    lines.push(`- **${humanise(key)}:** ${cleaned}`);
  }

  lines.push(`- **Comment Count:** ${comments.length}`);

  // Measure content size before inserting size fields
  if (showDescription) lines.push("", "## Description", "", description);
  lines.push("", "## Comments", "");
  for (let i = 0; i < comments.length; i++) {
    lines.push(...renderComment(i + 1, comments[i] as Record<string, unknown>));
  }

  const content = lines.join("\n");
  const charCount = content.length;

  // Insert Content Size and No of lines after Comment Count
  const ccIdx = lines.findIndex((l) => l.includes("**Comment Count:**"));
  lines.splice(ccIdx + 1, 0, `- **Content Size:** ${charCount.toLocaleString()} chars`);
  const lineCount = lines.length + 1;
  lines.splice(ccIdx + 2, 0, `- **No of lines:** ${lineCount}`);

  return {
    content: lines.join("\n"),
    filename,
    meta: {
      filename,
      tid: String(tid),
      title,
      status: String(ticket["ticket_status"] ?? ""),
      priority: String(ticket["ticket_priority"] ?? ""),
      commentCount: comments.length,
      charCount,
      lineCount,
    },
  };
}

function writeMetadataMarkdown(label: string, metas: TicketMeta[]): string {
  const lines = [
    `# Support Tickets Export — ${label}`,
    "",
    `**Total Tickets:** ${metas.length}`,
    "",
    "| File | Title | Status | Priority | Comments |",
    "|------|-------|--------|----------|----------|",
  ];
  for (const m of metas) {
    lines.push(
      `| [${m.filename}](${m.filename}) | ${m.title.slice(0, 60)} | ${m.status} | ${m.priority} | ${m.commentCount} |`
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(): { connector: string; months: number; outputDir: string } {
  const args = process.argv.slice(2);
  let connector = "";
  let months = 6;
  let outputDir = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--connector") connector = args[++i];
    else if (args[i] === "--months") months = parseInt(args[++i], 10);
    else if (args[i] === "--output") outputDir = args[++i];
  }

  if (!connector) {
    console.error(
      "Usage: npx tsx scripts/fetch_raw_tickets.ts --connector <name> [--months 6] [--output /tmp/hubspot_tickets]"
    );
    process.exit(1);
  }

  if (!outputDir) outputDir = `/tmp/${connector}_tickets`;
  return { connector, months, outputDir };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { connector, months, outputDir } = parseArgs();

  const connectorValue = CONNECTOR_MAP[connector];
  if (!connectorValue) {
    console.error(`Unknown connector: "${connector}". Available: ${Object.keys(CONNECTOR_MAP).join(", ")}`);
    process.exit(1);
  }

  console.log(`Fetching last ${months} months of tickets for: ${connector} (${connectorValue})`);

  const rawSql = await fs.readFile(SQL_PATH, "utf8");
  const sql = adaptSql(rawSql);
  const binds: snowflake.Binds = [connectorValue, -months];

  const conn = await createConnection();
  await connect(conn);
  console.log("Connected to Snowflake. Running query...");

  const rows = await fetchRows(conn, sql, binds);
  conn.destroy(() => {});
  console.log(`Fetched ${rows.length} tickets.`);

  await fs.mkdir(outputDir, { recursive: true });

  const metas: TicketMeta[] = [];
  for (let i = 0; i < rows.length; i++) {
    const { content, filename, meta } = writeTicketMarkdown(rows[i], i + 1);
    await fs.writeFile(path.join(outputDir, filename), content, "utf8");
    metas.push(meta);
  }

  const metadataContent = writeMetadataMarkdown(connector, metas);
  await fs.writeFile(path.join(outputDir, "metadata.md"), metadataContent, "utf8");

  console.log(`Written ${rows.length} ticket files + metadata.md → ${outputDir}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
