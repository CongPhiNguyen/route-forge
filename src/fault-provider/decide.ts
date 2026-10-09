export type Scenario = "success" | "429" | "500" | "timeout" | "stampede" | "budget";
export type Role = "primary" | "fallback";

export const FIXED_CONTENT = "route-forge-fixed";

export const FIXED_COMPLETION = {
  id: "chatcmpl-routeforge-fixed",
  object: "chat.completion",
  created: 1760054400,
  model: "gpt-4.1-mini-2025-04-14",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: FIXED_CONTENT },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
  },
};

export interface Decision {
  status: number;
  delayMs: number;
  headers: Record<string, string>;
  body: unknown;
}

export function parseScenario(value: string | undefined, fallback: Scenario): Scenario {
  if (
    value === "success" ||
    value === "429" ||
    value === "500" ||
    value === "timeout" ||
    value === "stampede" ||
    value === "budget"
  ) {
    return value;
  }
  return fallback;
}

export function parseRole(value: string | undefined): Role {
  return value === "fallback" ? "fallback" : "primary";
}

export function decide(input: {
  scenario: Scenario;
  role: Role;
  latencyMs: number;
  timeoutMs: number;
  stampedeMs: number;
}): Decision {
  if (input.role === "fallback") {
    return { status: 200, delayMs: input.latencyMs, headers: {}, body: FIXED_COMPLETION };
  }
  if (input.scenario === "429") {
    return {
      status: 429,
      delayMs: input.latencyMs,
      headers: { "Retry-After": "1" },
      body: {
        error: { message: "RouteForge fault 429", type: "rate_limit_error", code: "429" },
      },
    };
  }
  if (input.scenario === "500") {
    return {
      status: 500,
      delayMs: input.latencyMs,
      headers: {},
      body: {
        error: { message: "RouteForge fault 500", type: "internal_server_error", code: "500" },
      },
    };
  }
  if (input.scenario === "timeout") {
    return {
      status: 200,
      delayMs: input.latencyMs + input.timeoutMs,
      headers: {},
      body: FIXED_COMPLETION,
    };
  }
  if (input.scenario === "stampede") {
    return {
      status: 200,
      delayMs: input.latencyMs + input.stampedeMs,
      headers: {},
      body: FIXED_COMPLETION,
    };
  }
  return { status: 200, delayMs: input.latencyMs, headers: {}, body: FIXED_COMPLETION };
}
