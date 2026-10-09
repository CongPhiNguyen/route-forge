import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../src/runner/paths.ts";

const root = repoRoot();
const proxyUrl = process.env.PROXY_URL ?? "http://127.0.0.1:4000";
const masterKey = process.env.LITELLM_MASTER_KEY ?? "sk-routeforge-local-master";
const keysFile = process.env.KEYS_FILE ?? path.join(root, ".secrets", "keys.json");
const aliases = ["f-nocache", "f-exact", "f-budget", "p-nocache", "p-exact"] as const;
const models = ["lab-chat", "lab-chat-fallback", "lab-chat-retry"];

const keys = existsSync(keysFile) ? (JSON.parse(readFileSync(keysFile, "utf8")) as Record<string, string>) : {};

for (const alias of aliases) {
  if (keys[alias] && (await keyWorks(keys[alias]))) {
    process.stdout.write(`${alias} already present\n`);
    continue;
  }
  const generated = await generate(alias);
  keys[alias] = generated;
  process.stdout.write(`${alias} generated\n`);
}

await updateBudget(keys["f-budget"]);
mkdirSync(path.dirname(keysFile), { recursive: true });
writeFileSync(keysFile, JSON.stringify(keys, null, 2), "utf8");
process.stdout.write(`keys=${keysFile}\n`);

async function keyWorks(key: string): Promise<boolean> {
  const response = await fetch(`${proxyUrl}/key/info?key=${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${masterKey}` },
  });
  return response.ok;
}

async function generate(alias: string): Promise<string> {
  const response = await fetch(`${proxyUrl}/key/generate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${masterKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      key_alias: alias,
      models,
      max_budget: alias === "f-budget" ? 0.01 : 100,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`key/generate ${alias} failed ${response.status}: ${text}`);
  const body = JSON.parse(text) as { key?: string };
  if (!body.key) throw new Error(`key/generate ${alias} returned no key: ${text}`);
  return body.key;
}

async function updateBudget(key: string): Promise<void> {
  const response = await fetch(`${proxyUrl}/key/update`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${masterKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ key, spend: 1, max_budget: 0.01 }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`key/update f-budget failed ${response.status}: ${text}`);
  process.stdout.write("f-budget spend set above max_budget\n");
}
