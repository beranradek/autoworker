import http from "node:http";
import { getConfig } from "../config.js";
import { getStatus } from "../status.js";

function json(res: http.ServerResponse, statusCode: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

export function startHealthServer(): void {
  const cfg = getConfig();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/healthz" || url === "/readyz" || url === "/")) {
      json(res, 200, { ok: true, status: getStatus() });
      return;
    }
    json(res, 404, { ok: false, error: "not_found" });
  });

  server.listen(cfg.HEALTH_PORT, cfg.HEALTH_HOST);
}

