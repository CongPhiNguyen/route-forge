import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "../src/runner/paths.ts";

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "src/runner/cli.ts", ...args], {
      cwd: repoRoot(),
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("dry-run writes a report and sends nothing", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(500);
    res.end("unexpected");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await runCli(["dry-run"], {
      PROXY_URL: `http://127.0.0.1:${port}`,
      FAULT_URL: `http://127.0.0.1:${port}`,
      ROUTEFORGE_ALLOW_PAID: "",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /send_count=0/);
    assert.equal(hits, 0);
    const report = /report=(.+)/.exec(result.stdout)?.[1].trim();
    assert.ok(report);
    assert.match(readFileSync(report, "utf8"), /No client requests were sent/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("lane-p exits before any socket when the paid flag is absent", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200);
    res.end("paid");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await runCli(["lane-p"], {
      PROXY_URL: `http://127.0.0.1:${port}`,
      FAULT_URL: `http://127.0.0.1:${port}`,
      ROUTEFORGE_ALLOW_PAID: "",
      OPENAI_BASE_URL: `http://127.0.0.1:${port}`,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ROUTEFORGE_ALLOW_PAID is not 1/);
    assert.equal(hits, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("lane-p still opens no socket when the flag is set", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200);
    res.end("paid");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await runCli(["lane-p"], {
      PROXY_URL: `http://127.0.0.1:${port}`,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}`,
      ROUTEFORGE_ALLOW_PAID: "1",
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not part of this slice/);
    assert.equal(hits, 0);
    assert.equal(path.basename("src/runner/cli.ts"), "cli.ts");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
