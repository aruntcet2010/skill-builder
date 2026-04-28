/**
 * Fetch raw Zendesk tickets from Snowflake for a given connector.
 * Filters to the last N months. Outputs JSON array to a file.
 *
 * Usage: npx tsx scripts/fetch_raw_tickets.ts --connector hubspot [--months 6] [--output /tmp/hubspot_raw_tickets.json]
 */

import snowflake from "snowflake-sdk";
import fs from "fs/promises";
import path from "path";
import { config as loadEnv } from "dotenv";

loadEnv();

// ---------------------------------------------------------------------------
// Connector name → Snowflake custom field value
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
// SQL path (read from hevo-connector-agent sibling repo)
// ---------------------------------------------------------------------------
const SQL_PATH = path.resolve(
  import.meta.dirname,
  "../../hevo-connector-agent/scripts/tickets_summary/zendesk_tickets_by_connector.sql"
);

// ---------------------------------------------------------------------------
// Modify SQL for JS SDK (positional ? binds + date filter)
// ---------------------------------------------------------------------------
function adaptSql(rawSql: string, months: number): string {
  return (
    rawSql
      // Python %% escape → plain %
      .replace(/%%/g, "%")
      // Python-style named param → positional bind[0]
      .replace("%(connector_value)s", "?")
      // Inject date filter as bind[1] right after the connector value line
      .replace(
        "AND f.value['value']::VARCHAR = ?",
        `AND f.value['value']::VARCHAR = ?\n      AND t.CREATED_AT >= DATEADD(month, ?, CURRENT_DATE())`
      )
  );
}

// ---------------------------------------------------------------------------
// Snowflake connection
// ---------------------------------------------------------------------------
function createConnection(): snowflake.Connection {
  return snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT!,
    username: process.env.SNOWFLAKE_USER!,
    password: process.env.SNOWFLAKE_PASSWORD!,
    database: "HEVO_ANALYTICS",
    schema: "RAW",
    warehouse: "COMPUTE_WH",
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
        // Lowercase all column names
        const normalised = (rows ?? []).map((row) =>
          Object.fromEntries(
            Object.entries(row as Record<string, unknown>).map(([k, v]) => [
              k.toLowerCase(),
              v,
            ])
          )
        );
        resolve(normalised);
      },
    })
  );
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(): { connector: string; months: number; output: string } {
  const args = process.argv.slice(2);
  let connector = "";
  let months = 6;
  let output = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--connector") connector = args[++i];
    else if (args[i] === "--months") months = parseInt(args[++i], 10);
    else if (args[i] === "--output") output = args[++i];
  }

  if (!connector) {
    console.error("Usage: npx tsx scripts/fetch_raw_tickets.ts --connector <name> [--months 6] [--output /tmp/out.json]");
    process.exit(1);
  }

  if (!output) output = `/tmp/${connector}_raw_tickets.json`;
  return { connector, months, output };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { connector, months, output } = parseArgs();

  const connectorValue = CONNECTOR_MAP[connector];
  if (!connectorValue) {
    console.error(`Unknown connector: "${connector}". Available: ${Object.keys(CONNECTOR_MAP).join(", ")}`);
    process.exit(1);
  }

  console.log(`Fetching last ${months} months of tickets for connector: ${connector} (${connectorValue})`);

  const rawSql = await fs.readFile(SQL_PATH, "utf8");
  const sql = adaptSql(rawSql, months);
  const binds: snowflake.Binds = [connectorValue, -months];

  const conn = createConnection();
  await connect(conn);

  console.log("Connected to Snowflake. Running query...");
  const rows = await fetchRows(conn, sql, binds);
  conn.destroy(() => {});

  console.log(`Fetched ${rows.length} tickets.`);
  await fs.writeFile(output, JSON.stringify(rows, null, 2), "utf8");
  console.log(`Written to ${output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
