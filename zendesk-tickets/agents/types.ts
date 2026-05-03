export interface SymptomSummary {
  title: string;
  description: string;
  root_cause: string;
  ticket_ids: string[];
}

export interface Symptom extends SymptomSummary {
  slug: string;
  summary: string;
  keywords: string[];
}
