import assert from "node:assert/strict";
import test from "node:test";
import { accountAttempts, formatTimeline, type AttemptEvent } from "../src/fault-provider/events.ts";
import { FaultState } from "../src/fault-provider/state.ts";

function event(partial: Partial<AttemptEvent> & Pick<AttemptEvent, "attempt_id" | "logical_request_id" | "arrived_at">): AttemptEvent {
  return {
    boot_id: "boot",
    scenario_id: "scenario",
    role: "primary",
    scenario: "429",
    completed_at: partial.arrived_at,
    client_finished_at: null,
    status: 429,
    ...partial,
  };
}

test("attempt accounting only increments matching events and can describe a late arrival", () => {
  const events = [
    event({ attempt_id: 1, logical_request_id: "a", arrived_at: "2026-10-10T00:00:00.000Z", client_finished_at: "2026-10-10T00:00:02.000Z" }),
    event({
      attempt_id: 2,
      logical_request_id: "a",
      role: "fallback",
      arrived_at: "2026-10-10T00:00:03.000Z",
      client_finished_at: "2026-10-10T00:00:02.000Z",
    }),
    event({ attempt_id: 3, logical_request_id: "b", arrived_at: "2026-10-10T00:00:04.000Z" }),
  ];
  const accounted = accountAttempts(events, "a");
  assert.deepEqual(accounted, { primary: 1, fallback: 1, total: 2, late: 1, open_after_client: 0 });
  assert.match(formatTimeline(events, "a"), /late/);
  assert.equal(accounted.total >= 0 && accounted.primary >= 0 && accounted.fallback >= 0, true);
});

test("reset is refused while an upstream call is open", () => {
  const state = new FaultState();
  state.begin({ scenarioId: "s", logicalRequestId: "r", role: "primary", scenario: "timeout" });
  assert.throws(() => state.reset(), /refuse reset/);
  state.complete(1, 200);
  state.reset();
  assert.equal(state.snapshot().events.length, 0);
});

test("an arrival after the client finished is marked late and is not dropped", () => {
  const state = new FaultState();
  state.markClientFinished("r", "2000-01-01T00:00:00.000Z");
  const started = state.begin({ scenarioId: "s", logicalRequestId: "r", role: "primary", scenario: "429" });
  assert.equal(started.client_finished_at, "2000-01-01T00:00:00.000Z");
  assert.ok(started.arrived_at > "2000-01-01T00:00:00.000Z");
  const accounted = accountAttempts(state.snapshot().events, "r");
  assert.equal(accounted.total, 1);
  assert.equal(accounted.late, 1);
});
