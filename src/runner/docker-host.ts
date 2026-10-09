import { readFileSync } from "node:fs";
import path from "node:path";

export type DockerTarget = "wsl" | "windows";

export function readDotEnv(root: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path.join(root, ".env"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function pick(env: NodeJS.ProcessEnv, fileEnv: Record<string, string>, key: string): string | undefined {
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  const fromFile = fileEnv[key];
  if (fromFile !== undefined && fromFile.trim() !== "") return fromFile.trim();
  return undefined;
}

export function dockerTarget(env: NodeJS.ProcessEnv, fileEnv: Record<string, string> = {}): DockerTarget {
  const raw = pick(env, fileEnv, "ROUTEFORGE_DOCKER")?.toLowerCase();
  if (raw === undefined) return "windows";
  if (raw === "wsl" || raw === "windows") return raw;
  throw new Error(`ROUTEFORGE_DOCKER must be wsl or windows, got ${raw}`);
}

export function dockerComposeInvocation(
  root: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; fileEnv?: Record<string, string> },
): { command: string; args: string[] } {
  const env = options?.env ?? process.env;
  const fileEnv = options?.fileEnv ?? readDotEnv(root);
  const composeArgs = ["compose", ...args];
  if (dockerTarget(env, fileEnv) === "windows") {
    return { command: "docker", args: composeArgs };
  }
  const distro = pick(env, fileEnv, "ROUTEFORGE_WSL_DISTRO") ?? "Ubuntu";
  return {
    command: "wsl",
    args: ["-d", distro, "--cd", root, "--", "docker", ...composeArgs],
  };
}
