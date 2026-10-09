export interface ProxyInspection {
  modelNames: string[];
  numRetries: number[];
  routerAllowedFails: number | null;
  deploymentAllowedFails: number[];
  fallbackCount: number;
  fallbacksEmpty: boolean;
  cacheMode: string | null;
  storePrompts: boolean | null;
  semanticCacheConfigured: boolean;
  containsOpenAiHost: boolean;
  containsFaultProvider: boolean;
  redisDb: number | null;
  deploymentMaxRetries: number[];
  disablesBudgetReservation: boolean;
  allowsRequestsOnDbUnavailable: boolean;
  disablesFallbackBudget: boolean;
}

export function inspectProxyConfig(text: string): ProxyInspection {
  const code = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const modelNames = [...code.matchAll(/model_name:\s*(\S+)/g)].map((match) => match[1]);
  const numRetries = [...code.matchAll(/num_retries:\s*(\d+)/g)].map((match) => Number(match[1]));
  const routerAllowed = /router_settings:[\s\S]*?allowed_fails:\s*(\d+)/.exec(code);
  const deploymentAllowedFails = [...code.matchAll(/model_info:[\s\S]*?allowed_fails:\s*(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  const fallbacksEmpty = /fallbacks:\s*\[\s*\]/.test(code);
  const fallbackTargets = fallbacksEmpty
    ? []
    : [...code.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((match) => match[1]);
  const mode = /mode:\s*(\S+)/.exec(code);
  const store = /store_prompts_in_spend_logs:\s*(true|false)/.exec(code);
  const redisDb = /db:\s*(\d+)/.exec(code);
  return {
    modelNames,
    numRetries,
    routerAllowedFails: routerAllowed ? Number(routerAllowed[1]) : null,
    deploymentAllowedFails,
    fallbackCount: fallbacksEmpty ? 0 : fallbackTargets.filter((name) => name.includes("fallback")).length,
    fallbacksEmpty,
    cacheMode: mode ? mode[1] : null,
    storePrompts: store ? store[1] === "true" : null,
    semanticCacheConfigured: /similarity_threshold|redis-semantic|type:\s*redis-semantic/.test(code),
    containsOpenAiHost: code.includes("api.openai.com") || /api_key:\s*os\.environ\/OPENAI_API_KEY/.test(code),
    containsFaultProvider: code.includes("fault-provider"),
    redisDb: redisDb ? Number(redisDb[1]) : null,
    deploymentMaxRetries: [...code.matchAll(/max_retries:\s*(\d+)/g)].map((match) => Number(match[1])),
    disablesBudgetReservation: /disable_budget_reservation:\s*true/.test(code),
    allowsRequestsOnDbUnavailable: /allow_requests_on_db_unavailable:\s*true/.test(code),
    disablesFallbackBudget: /enforce_fallback_budget:\s*false/.test(code),
  };
}
