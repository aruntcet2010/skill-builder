export interface FullTicket {
  key: string;
  summary: string;
  status: string;
  priority: string;
  customerImpact: string | null;
  description: string;
  comments: { author: string; body: string; created: string }[];
}

export interface CauseWithTickets {
  cause: string;
  ticket_ids: string[];
}

export interface IssueTypeBucket {
  issue_type: string;
  causes_with_tickets: CauseWithTickets[];
}

export function formatTicketAsMarkdown(t: FullTicket): string {
  const lines = [
    `# ${t.key}: ${t.summary}`,
    "",
    "## Metadata",
    `- **Status:** ${t.status}`,
    `- **Priority:** ${t.priority}`,
    `- **Customer Impact:** ${t.customerImpact ?? "N/A"}`,
    `- **Comment Count:** ${t.comments.length}`,
    "",
    "## Description",
    "",
    t.description || "_(empty)_",
    "",
    "## Comments",
    "",
  ];

  if (t.comments.length === 0) {
    lines.push("_(none)_");
  } else {
    t.comments.forEach((c, i) => {
      lines.push(`### Comment ${i + 1}`);
      lines.push(`- **Author:** ${c.author}`);
      lines.push(`- **Created:** ${c.created.slice(0, 19).replace("T", " ")}`);
      lines.push("");
      lines.push(c.body || "_(empty)_");
      lines.push("");
    });
  }

  return lines.join("\n");
}
