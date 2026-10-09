import type { Role, Scenario } from "./decide.ts";

export interface AttemptEvent {
  attempt_id: number;
  boot_id: string;
  scenario_id: string;
  logical_request_id: string;
  role: Role;
  scenario: Scenario;
  arrived_at: string;
  completed_at: string | null;
  client_finished_at: string | null;
  status: number | null;
}

export interface AttemptAccounting {
  primary: number;
  fallback: number;
  total: number;
  late: number;
  open_after_client: number;
}

export function accountAttempts(events: AttemptEvent[], logicalRequestId: string): AttemptAccounting {
  const mine = events.filter((event) => event.logical_request_id === logicalRequestId);
  let primary = 0;
  let fallback = 0;
  let late = 0;
  let openAfterClient = 0;
  for (const event of mine) {
    if (event.role === "fallback") fallback += 1;
    else primary += 1;
    const finished = event.client_finished_at;
    if (finished && event.arrived_at > finished) late += 1;
    if (finished && event.completed_at === null) openAfterClient += 1;
  }
  return {
    primary,
    fallback,
    total: primary + fallback,
    late,
    open_after_client: openAfterClient,
  };
}

export function formatTimeline(events: AttemptEvent[], logicalRequestId: string): string {
  const mine = events
    .filter((event) => event.logical_request_id === logicalRequestId)
    .slice()
    .sort((a, b) => a.attempt_id - b.attempt_id);
  if (mine.length === 0) return `${logicalRequestId}: no upstream arrivals`;
  const origin = Date.parse(mine[0].arrived_at);
  return mine
    .map((event) => {
      const at = Date.parse(event.arrived_at) - origin;
      const done = event.completed_at === null ? "open" : `status ${event.status} +${Date.parse(event.completed_at) - origin}ms`;
      const late = event.client_finished_at && event.arrived_at > event.client_finished_at ? " late" : "";
      return `#${event.attempt_id} ${event.role} +${at}ms ${done}${late}`;
    })
    .join("; ");
}
