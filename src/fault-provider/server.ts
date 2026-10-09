import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { decide, parseRole, parseScenario, type Scenario } from "./decide.ts";
import { FaultState } from "./state.ts";

const port = Number(process.env.PORT ?? "8080");
const timeoutMs = Number(process.env.ROUTEFORGE_TIMEOUT_MS ?? "5000");
const stampedeMs = Number(process.env.ROUTEFORGE_STAMPEDE_MS ?? "200");

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function createFaultServer() {
  const state = new FaultState();
  state.latencyMs = Number(process.env.ROUTEFORGE_LATENCY_MS ?? "0");
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fault.local");
    try {
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/_stats" || url.pathname === "/_events")) {
        sendJson(res, 200, url.pathname === "/health" ? { ok: true, boot_id: state.bootId } : state.snapshot());
        return;
      }
      if (req.method === "POST" && url.pathname === "/_reset") {
        try {
          state.reset();
        } catch (error) {
          sendJson(res, 409, { error: error instanceof Error ? error.message : String(error), ...state.snapshot() });
          return;
        }
        sendJson(res, 200, state.snapshot());
        return;
      }
      if (req.method === "POST" && url.pathname === "/_control") {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { scenario?: string; scenario_id?: string; latency_ms?: number }) : {};
        if (body.scenario) state.scenario = parseScenario(body.scenario, state.scenario);
        if (body.scenario_id) state.scenarioId = body.scenario_id;
        if (typeof body.latency_ms === "number") state.latencyMs = body.latency_ms;
        sendJson(res, 200, state.snapshot());
        return;
      }
      if (req.method === "POST" && url.pathname === "/_client-finished") {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as { logical_request_id?: string; finished_at?: string };
        if (!body.logical_request_id || !body.finished_at) {
          sendJson(res, 400, { error: "logical_request_id and finished_at are required" });
          return;
        }
        state.markClientFinished(body.logical_request_id, body.finished_at);
        sendJson(res, 200, state.snapshot());
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const scenario: Scenario = parseScenario(header(req, "x-routeforge-scenario"), state.scenario);
        const role = parseRole(header(req, "x-routeforge-role"));
        const requestId = header(req, "x-routeforge-request-id") ?? "unattributed";
        const scenarioId = header(req, "x-routeforge-scenario-id") ?? state.scenarioId;
        const event = state.begin({ scenarioId, logicalRequestId: requestId, role, scenario });
        const decision = decide({
          scenario,
          role,
          latencyMs: state.latencyMs,
          timeoutMs,
          stampedeMs,
        });
        try {
          if (decision.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
          state.complete(event.attempt_id, decision.status);
          sendJson(res, decision.status, decision.body, decision.headers);
        } catch (error) {
          state.complete(event.attempt_id, 0);
          throw error;
        }
        return;
      }
      sendJson(res, 404, { error: { message: "not found" } });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

const isMain = process.argv[1]?.replaceAll("\\", "/").endsWith("/src/fault-provider/server.ts");
if (isMain) {
  const server = createFaultServer();
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`fault-provider listening on ${port}\n`);
  });
}
