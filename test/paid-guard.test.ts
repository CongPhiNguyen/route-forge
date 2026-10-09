import assert from "node:assert/strict";
import test from "node:test";
import { PaidDeniedError, assertPaidLane } from "../src/runner/paid-guard.ts";

const matching = {
  lane: "P",
  configHash: "abc",
  expectedHash: "abc",
  numRetries: [0, 0],
  deploymentCount: 1,
  fallbackCount: 0,
  containsOpenAiHost: true,
};

test("paid-provider configuration is blocked when ROUTEFORGE_ALLOW_PAID is absent", () => {
  assert.throws(
    () => assertPaidLane({ ...matching, allowPaid: undefined }),
    (error: unknown) => error instanceof PaidDeniedError && error.message === "ROUTEFORGE_ALLOW_PAID is not 1",
  );
});

test("paid lane rejects a config hash that does not match the manifest", () => {
  assert.throws(
    () => assertPaidLane({ ...matching, allowPaid: "1", configHash: "other" }),
    /hash does not match/,
  );
});

test("a matching paid flag still does not start Lane P in this slice", () => {
  assert.throws(() => assertPaidLane({ ...matching, allowPaid: "1" }), /not part of this slice/);
});
