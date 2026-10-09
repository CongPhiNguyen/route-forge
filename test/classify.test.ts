import assert from "node:assert/strict";
import test from "node:test";
import { amplification, classifyGatewayCache } from "../src/runner/classify.ts";

test("replayed usage does not confirm a cache hit", () => {
  const replayedUsage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };
  assert.equal(replayedUsage.total_tokens, 16);
  assert.equal(
    classifyGatewayCache({
      cacheEnabled: true,
      cacheKeyHeader: "sha256-of-body",
      semanticSimilarityHeader: null,
      upstreamAttempts: 1,
    }),
    "miss",
  );
});

test("a hit needs the cache-key header and zero new upstream attempts", () => {
  assert.equal(
    classifyGatewayCache({
      cacheEnabled: true,
      cacheKeyHeader: "abc",
      semanticSimilarityHeader: null,
      upstreamAttempts: 0,
    }),
    "hit",
  );
  assert.equal(
    classifyGatewayCache({
      cacheEnabled: false,
      cacheKeyHeader: null,
      semanticSimilarityHeader: null,
      upstreamAttempts: 1,
    }),
    "bypass",
  );
});

test("semantic similarity header fails the classification", () => {
  assert.throws(
    () =>
      classifyGatewayCache({
        cacheEnabled: true,
        cacheKeyHeader: "abc",
        semanticSimilarityHeader: "0.99",
        upstreamAttempts: 0,
      }),
    /semantic/,
  );
});

test("retry amplification is upstream attempts divided by client requests", () => {
  assert.equal(amplification(60, 20), 3);
  assert.equal(amplification(3, 1), 3);
});
