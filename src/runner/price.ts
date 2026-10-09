import { readFileSync } from "node:fs";

export interface ModelPrice {
  status: "active" | "inactive";
  input_per_million: number;
  cached_input_per_million: number;
  cache_write_per_million: number | null;
  output_per_million: number;
}

export interface PriceCard {
  id: string;
  source_url: string;
  fetched_on: string;
  tier: string;
  currency: string;
  models: Record<string, ModelPrice>;
}

export class InactiveModelError extends Error {
  readonly code = "inactive_model";
  constructor(modelId: string) {
    super(`Model ${modelId} is inactive on the price card`);
  }
}

export function loadPriceCard(file: string): PriceCard {
  const card = JSON.parse(readFileSync(file, "utf8")) as PriceCard;
  if (!card.fetched_on) throw new Error("Price card is missing fetched_on");
  if (!card.id) throw new Error("Price card is missing id");
  return card;
}

export function assertModelActive(card: PriceCard, modelId: string): ModelPrice {
  const model = card.models[modelId];
  if (!model) throw new Error(`Model ${modelId} is not on price card ${card.id}`);
  if (model.status !== "active") throw new InactiveModelError(modelId);
  return model;
}

export function estimateReservationUsd(
  card: PriceCard,
  modelId: string,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  const model = assertModelActive(card, modelId);
  return (inputTokens * model.input_per_million + maxOutputTokens * model.output_per_million) / 1_000_000;
}

export function priceUsageUsd(
  card: PriceCard,
  modelId: string,
  usage: { prompt_tokens: number; cached_tokens: number; completion_tokens: number },
): number {
  const model = assertModelActive(card, modelId);
  const uncached = usage.prompt_tokens - usage.cached_tokens;
  if (uncached < 0) throw new Error("cached_tokens exceed prompt_tokens");
  return (
    (uncached * model.input_per_million +
      usage.cached_tokens * model.cached_input_per_million +
      usage.completion_tokens * model.output_per_million) /
    1_000_000
  );
}
