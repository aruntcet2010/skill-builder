export interface SymptomSummary {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  ticket_ids: string[];
}

export interface Symptom extends SymptomSummary {
  slug: string;
  keywords: string[];
}
