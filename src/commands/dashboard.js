import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { metrics } from "./metrics.js";

const PROTOCOL_VERSION = "agentshell.dashboard.v1";
const DEFAULT_PORT = 4317;
const ASSET_ROOT = path.resolve(import.meta.dirname, "..", "dashboard");
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DASHBOARD_APP = path.join(PACKAGE_ROOT, "desktop", "macos", "dist", "AgentShell Dashboard.app");
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);

export async function startDashboard(root, options = {}) {
  const requestedPort = parsePort(options.port);
  const server = createServer(root);
  const address = await listen(server, requestedPort);
  const url = `http://127.0.0.1:${address.port}/`;
  const launch = launchSurface(url, options);

  return {
    server,
    report: {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      url,
      host: "127.0.0.1",
      port: address.port,
      opened: launch.opened,
      surface: launch.surface,
      nativeAppAvailable: fs.existsSync(DASHBOARD_APP),
      readOnly: true,
      privacy: {
        localOnly: true,
        networkUpload: false,
        servesFileContents: false,
        servesCommandOutput: false
      },
      nextAction: "Keep this process running while viewing the AgentShell dashboard."
    }
  };
}

function launchSurface(url, options) {
  if (options.open === false) return { opened: false, surface: "none" };
  const preferred = options.surface || (process.platform === "darwin" ? "window" : "browser");
  if (preferred === "window" && process.platform === "darwin" && fs.existsSync(DASHBOARD_APP)) {
    const result = spawnSync("open", ["-n", DASHBOARD_APP, "--args", "--url", url], {
      encoding: "utf8"
    });
    if (result.status === 0) return { opened: true, surface: "desktop-window" };
  }
  return {
    opened: openUrl(url),
    surface: preferred === "window" ? "browser-fallback" : "browser"
  };
}

function createServer(root) {
  return http.createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method !== "GET") return sendJson(response, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
      if (url.pathname === "/api/health") {
        return sendJson(response, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
      }
      if (url.pathname === "/api/metrics") {
        const report = await metrics(root, { compact: true, limit: url.searchParams.get("limit") || 500 });
        return sendJson(response, 200, report);
      }
      const asset = ASSETS.get(url.pathname);
      if (!asset) return sendJson(response, 404, { ok: false, error: "NOT_FOUND" });
      return sendAsset(response, asset[0], asset[1]);
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: "DASHBOARD_ERROR", message: error.message });
    }
  });
}

function listen(server, requestedPort) {
  return new Promise((resolve, reject) => {
    let port = requestedPort;
    const tryListen = () => {
      const onError = (error) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && requestedPort !== 0 && port < requestedPort + 10) {
          port += 1;
          tryListen();
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(server.address());
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };
    tryListen();
  });
}

function sendAsset(response, fileName, contentType) {
  const file = path.join(ASSET_ROOT, fileName);
  if (!fs.existsSync(file)) return sendJson(response, 404, { ok: false, error: "ASSET_NOT_FOUND" });
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(fs.readFileSync(file));
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function setSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function parsePort(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Dashboard port must be an integer from 0 to 65535");
  return port;
}

function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
