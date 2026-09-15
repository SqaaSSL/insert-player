export interface CrewSummary {
  id: string;
  name: string;
  slug: string | null;
}

export interface CrewMembershipSummary extends CrewSummary {
  role: string | null;
}
