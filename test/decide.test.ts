import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../src/fault-provider/decide.ts";

test("fault decisions cover success, 429, 500, timeout, and latency", () => {
  const success = decide({ scenario: "success", role: "primary", latencyMs: 15, timeoutMs: 5000, stampedeMs: 200 });
  assert.equal(success.status, 200);
  assert.equal(success.delayMs, 15);

  const limited = decide({ scenario: "429", role: "primary", latencyMs: 0, timeoutMs: 5000, stampedeMs: 200 });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["Retry-After"], "1");

  const failed = decide({ scenario: "500", role: "primary", latencyMs: 0, timeoutMs: 5000, stampedeMs: 200 });
  assert.equal(failed.status, 500);

  const timeout = decide({ scenario: "timeout", role: "primary", latencyMs: 5, timeoutMs: 5000, stampedeMs: 200 });
  assert.equal(timeout.delayMs, 5005);

  const fallback = decide({ scenario: "500", role: "fallback", latencyMs: 0, timeoutMs: 5000, stampedeMs: 200 });
  assert.equal(fallback.status, 200);
});
