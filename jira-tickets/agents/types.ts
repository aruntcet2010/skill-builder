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

export function formatTicketDump(tickets: FullTicket[]): string {
  return tickets.map((t) => {
    const commentBlock = t.comments.length
      ? t.comments.map((c) => `    [${c.author} @ ${c.created.slice(0, 10)}]: ${c.body}`).join("\n")
      : "    (none)";
    return `Key: ${t.key}
Summary: ${t.summary}
Status: ${t.status} | Priority: ${t.priority} | Customer Impact: ${t.customerImpact ?? "N/A"}
Description:
  ${t.description || "(empty)"}
Comments:
${commentBlock}`;
  }).join("\n\n---\n\n");
}
