export type GatewayCache = "miss" | "hit" | "bypass";

export interface CacheClassificationInput {
  cacheEnabled: boolean;
  cacheKeyHeader: string | null;
  semanticSimilarityHeader: string | null;
  upstreamAttempts: number;
}

export function classifyGatewayCache(input: CacheClassificationInput): GatewayCache {
  if (input.semanticSimilarityHeader) {
    throw new Error("x-litellm-semantic-similarity is out of scope");
  }
  if (!input.cacheEnabled) return "bypass";
  const header = (input.cacheKeyHeader ?? "").trim();
  const headerSet = header.length > 0 && header !== "None";
  if (headerSet && input.upstreamAttempts === 0) return "hit";
  return "miss";
}

export function amplification(upstreamAttempts: number, clientRequests: number): number {
  if (clientRequests <= 0) throw new Error("clientRequests must be positive");
  return upstreamAttempts / clientRequests;
}
