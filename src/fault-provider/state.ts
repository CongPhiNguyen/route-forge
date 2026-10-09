import { randomUUID } from "node:crypto";
import type { Role, Scenario } from "./decide.ts";
import { type AttemptEvent, accountAttempts } from "./events.ts";

export interface RoleCounts {
  total: number;
  primary: number;
  fallback: number;
}

export class FaultState {
  readonly bootId = randomUUID();
  scenario: Scenario = "success";
  scenarioId = "unset";
  latencyMs = 0;
  private nextAttemptId = 1;
  private readonly events: AttemptEvent[] = [];
  private inFlight = 0;
  private readonly clientFinishedAt = new Map<string, string>();

  reset(): void {
    if (this.inFlight !== 0) {
      throw new Error(`refuse reset while ${this.inFlight} upstream calls are still open`);
    }
    this.events.length = 0;
    this.clientFinishedAt.clear();
    this.nextAttemptId = 1;
  }

  begin(input: { scenarioId: string; logicalRequestId: string; role: Role; scenario: Scenario }): AttemptEvent {
    const event: AttemptEvent = {
      attempt_id: this.nextAttemptId,
      boot_id: this.bootId,
      scenario_id: input.scenarioId,
      logical_request_id: input.logicalRequestId,
      role: input.role,
      scenario: input.scenario,
      arrived_at: new Date().toISOString(),
      completed_at: null,
      client_finished_at: this.clientFinishedAt.get(input.logicalRequestId) ?? null,
      status: null,
    };
    this.nextAttemptId += 1;
    this.events.push(event);
    this.inFlight += 1;
    return event;
  }

  complete(attemptId: number, status: number): void {
    const event = this.events.find((item) => item.attempt_id === attemptId);
    if (!event || event.completed_at) return;
    event.completed_at = new Date().toISOString();
    event.status = status;
    this.inFlight -= 1;
  }

  markClientFinished(logicalRequestId: string, finishedAt: string): void {
    this.clientFinishedAt.set(logicalRequestId, finishedAt);
    for (const event of this.events) {
      if (event.logical_request_id === logicalRequestId) event.client_finished_at = finishedAt;
    }
  }

  countsFor(logicalRequestId: string): RoleCounts {
    const accounted = accountAttempts(this.events, logicalRequestId);
    return { total: accounted.total, primary: accounted.primary, fallback: accounted.fallback };
  }

  snapshot(): {
    boot_id: string;
    scenario: Scenario;
    scenario_id: string;
    latency_ms: number;
    in_flight: number;
    totals: RoleCounts;
    requests: Record<string, RoleCounts>;
    events: AttemptEvent[];
  } {
    const requests: Record<string, RoleCounts> = {};
    for (const event of this.events) {
      const current = requests[event.logical_request_id] ?? { total: 0, primary: 0, fallback: 0 };
      current.total += 1;
      current[event.role] += 1;
      requests[event.logical_request_id] = current;
    }
    const totals = Object.values(requests).reduce(
      (sum, counts) => ({
        total: sum.total + counts.total,
        primary: sum.primary + counts.primary,
        fallback: sum.fallback + counts.fallback,
      }),
      { total: 0, primary: 0, fallback: 0 },
    );
    return {
      boot_id: this.bootId,
      scenario: this.scenario,
      scenario_id: this.scenarioId,
      latency_ms: this.latencyMs,
      in_flight: this.inFlight,
      totals,
      requests,
      events: this.events.map((event) => ({ ...event })),
    };
  }
}
