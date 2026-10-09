export const INVOCATION_CEILING_USD = 1.5;
export const MAX_REQUESTS = 80;

export interface ReservationState {
  committedUsd: number;
  sent: number;
}

export interface ReservationDecision {
  allowed: boolean;
  reason: string | null;
  committedUsd: number;
}

export function reserve(state: ReservationState, estimateUsd: number): ReservationDecision {
  if (state.sent + 1 > MAX_REQUESTS) {
    return { allowed: false, reason: "runner_ceiling_requests", committedUsd: state.committedUsd };
  }
  if (state.committedUsd + estimateUsd > INVOCATION_CEILING_USD) {
    return { allowed: false, reason: "runner_ceiling_usd", committedUsd: state.committedUsd };
  }
  return {
    allowed: true,
    reason: null,
    committedUsd: state.committedUsd + estimateUsd,
  };
}

export function settle(committedUsd: number, estimateUsd: number, billableUsd: number | null): number {
  if (billableUsd === null) return committedUsd;
  return committedUsd - estimateUsd + billableUsd;
}
