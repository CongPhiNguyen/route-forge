import assert from "node:assert/strict";
import test from "node:test";
import { dockerComposeInvocation, dockerTarget } from "../src/runner/docker-host.ts";

test("ROUTEFORGE_DOCKER selects the compose host", () => {
  assert.equal(dockerTarget({}), "windows");
  assert.equal(dockerTarget({ ROUTEFORGE_DOCKER: "wsl" }), "wsl");
  assert.equal(dockerTarget({}, { ROUTEFORGE_DOCKER: "wsl" }), "wsl");
  assert.equal(dockerTarget({ ROUTEFORGE_DOCKER: "windows" }, { ROUTEFORGE_DOCKER: "wsl" }), "windows");
  assert.throws(() => dockerTarget({ ROUTEFORGE_DOCKER: "podman" }), /wsl or windows/);
});

test("wsl target runs docker compose inside the distro", () => {
  const invocation = dockerComposeInvocation("C:\\phi-nguyen\\route-forge", ["up", "-d"], {
    env: { ROUTEFORGE_DOCKER: "wsl", ROUTEFORGE_WSL_DISTRO: "Ubuntu" },
    fileEnv: {},
  });
  assert.equal(invocation.command, "wsl");
  assert.deepEqual(invocation.args, [
    "-d",
    "Ubuntu",
    "--cd",
    "C:\\phi-nguyen\\route-forge",
    "--",
    "docker",
    "compose",
    "up",
    "-d",
  ]);
});

test("windows target uses docker on PATH", () => {
  const invocation = dockerComposeInvocation("C:\\phi-nguyen\\route-forge", ["ps"], {
    env: {},
    fileEnv: {},
  });
  assert.deepEqual(invocation, { command: "docker", args: ["compose", "ps"] });
});
