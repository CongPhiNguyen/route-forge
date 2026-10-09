import assert from "node:assert/strict";
import test from "node:test";
import { reserve, settle } from "../src/runner/reservation.ts";

test("reservation stops above 1.50 USD or 80 requests", () => {
  const usd = reserve({ committedUsd: 1.49, sent: 1 }, 0.02);
  assert.equal(usd.allowed, false);
  assert.equal(usd.reason, "runner_ceiling_usd");
  const requests = reserve({ committedUsd: 0, sent: 80 }, 0.01);
  assert.equal(requests.allowed, false);
  assert.equal(requests.reason, "runner_ceiling_requests");
});

test("a response replaces the estimate and a missing usage keeps it", () => {
  const reserved = reserve({ committedUsd: 0, sent: 0 }, 0.01);
  assert.equal(settle(reserved.committedUsd, 0.01, 0), 0);
  assert.equal(settle(reserved.committedUsd, 0.01, null), 0.01);
});
