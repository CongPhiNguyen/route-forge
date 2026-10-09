import { spawnSync } from "node:child_process";
import { dockerComposeInvocation, dockerTarget, readDotEnv } from "../src/runner/docker-host.ts";
import { repoRoot } from "../src/runner/paths.ts";

const root = repoRoot();
const fileEnv = readDotEnv(root);
const target = dockerTarget(process.env, fileEnv);
console.error(`ROUTEFORGE_DOCKER=${target}`);
const invocation = dockerComposeInvocation(root, process.argv.slice(2), { env: process.env, fileEnv });
const result = spawnSync(invocation.command, invocation.args, {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
