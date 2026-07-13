import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { metrics } from "./metrics.js";
import { resolvePackageRoot } from "../core/package-root.js";

const PROTOCOL_VERSION = "agentshell.dashboard.v1";
const DEFAULT_PORT = 4317;
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);

export async function startDashboard(root, options = {}) {
  const singleton = options.singleton !== false;
  const runtime = runtimePaths(options);
  if (singleton) {
    const existing = await claimDashboard(root, runtime, options);
    if (existing) {
      const launch = launchSurface(existing.url, options);
      return dashboardSession(null, existing, launch, true, async () => {}, options);
    }
  }

  const requestedPort = parsePort(options.port);
  const server = createServer(root, options);
  let address;
  try {
    address = await listen(server, requestedPort);
  } catch (error) {
    if (singleton) releaseRuntime(runtime, process.pid);
    throw error;
  }
  const url = `http://127.0.0.1:${address.port}/`;
  const metadata = {
    pid: process.pid,
    root: path.resolve(root),
    version: pluginVersion(options),
    port: address.port,
    url,
    startedAt: new Date().toISOString()
  };
  if (singleton) writeJsonAtomic(runtime.state, metadata);
  const launch = launchSurface(url, options);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await closeServer(server);
    if (singleton) releaseRuntime(runtime, process.pid);
    if (isNativeSurface(launch.surface)) stopNativeWindows();
  };
  if (singleton && options.monitorParent !== false) monitorParent(close);

  return dashboardSession(server, metadata, launch, false, close, options);
}

export async function dashboardStatus(options = {}) {
  const runtime = runtimePaths(options);
  const state = readJson(runtime.state);
  const healthy = Boolean(state && isProcessAlive(state.pid) && await healthReady(state.url));
  return {
    ok: true,
    protocolVersion: "agentshell.dashboard-control.v1",
    running: healthy,
    state: healthy ? state : null
  };
}

export async function stopDashboard(options = {}) {
  const runtime = runtimePaths(options);
  const state = readJson(runtime.state);
  if (state?.pid && state.pid !== process.pid && isProcessAlive(state.pid)) {
    try { process.kill(state.pid, "SIGTERM"); } catch {}
    await waitForExit(state.pid, 1500);
  }
  releaseRuntime(runtime, state?.pid);
  stopNativeWindows();
  return {
    ok: true,
    protocolVersion: "agentshell.dashboard-control.v1",
    stopped: Boolean(state),
    previousPid: state?.pid || null
  };
}

function dashboardSession(server, metadata, launch, reused, close, options) {
  return {
    server,
    close,
    report: {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      url: metadata.url,
      host: "127.0.0.1",
      port: metadata.port,
      pid: metadata.pid,
      reused,
      opened: launch.opened,
      surface: launch.surface,
      nativeAppAvailable: fs.existsSync(dashboardApp(options)),
      readOnly: true,
      privacy: {
        localOnly: true,
        networkUpload: false,
        servesFileContents: false,
        servesCommandOutput: false
      },
      nextAction: reused ? "Reused the healthy AgentShell dashboard." : "Dashboard is running as the user-level singleton."
    }
  };
}

function launchSurface(url, options) {
  if (options.open === false) return { opened: false, surface: "none" };
  const preferred = options.surface || (process.platform === "darwin" ? "menubar" : "browser");
  const app = dashboardApp(options);
  if (["menubar", "window"].includes(preferred) && process.platform === "darwin" && fs.existsSync(app)) {
    stopNativeWindows();
    const appArgs = [app, "--args", "--url", url];
    if (preferred === "window") appArgs.push("--show-window");
    const result = spawnSync("open", appArgs, {
      encoding: "utf8"
    });
    if (result.status === 0) return { opened: true, surface: preferred === "window" ? "desktop-window" : "menu-bar" };
  }
  return {
    opened: openUrl(url),
    surface: ["menubar", "window"].includes(preferred) ? "browser-fallback" : "browser"
  };
}

function isNativeSurface(surface) {
  return surface === "menu-bar" || surface === "desktop-window";
}

function runtimePaths(options) {
  const dir = path.resolve(options.runtimeDir || path.join(os.homedir(), ".agentshell"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    dir,
    lock: path.join(dir, "dashboard.lock"),
    state: path.join(dir, "dashboard.json")
  };
}

async function reusableDashboard(root, runtime, options) {
  const state = readJson(runtime.state);
  if (!state || state.root !== path.resolve(root) || state.version !== pluginVersion(options)) return null;
  if (!isProcessAlive(state.pid) || !await healthReady(state.url)) return null;
  return state;
}

async function claimDashboard(root, runtime, options) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const reusable = await reusableDashboard(root, runtime, options);
    if (reusable) return reusable;

    const state = readJson(runtime.state);
    if (state?.pid && state.pid !== process.pid && isProcessAlive(state.pid)) {
      try { process.kill(state.pid, "SIGTERM"); } catch {}
      await waitForExit(state.pid, 1500);
      fs.rmSync(runtime.state, { force: true });
      fs.rmSync(runtime.lock, { force: true });
    }

    try {
      acquireLock(runtime.lock);
      return null;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!state && lockIsStale(runtime.lock)) fs.rmSync(runtime.lock, { force: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Dashboard singleton lock could not be acquired");
}

function acquireLock(file) {
  const descriptor = fs.openSync(file, "wx", 0o600);
  fs.writeFileSync(descriptor, `${process.pid}\n`);
  fs.closeSync(descriptor);
}

function lockIsStale(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs > 5000; } catch { return true; }
}

function releaseRuntime(runtime, expectedPid) {
  const state = readJson(runtime.state);
  if (!state || !expectedPid || state.pid === expectedPid) {
    fs.rmSync(runtime.state, { force: true });
    fs.rmSync(runtime.lock, { force: true });
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function pluginVersion(options) {
  try {
    const manifest = path.join(packageRoot(options), ".codex-plugin", "plugin.json");
    return JSON.parse(fs.readFileSync(manifest, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function healthReady(url) {
  if (typeof url !== "string") return false;
  try {
    const response = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch { return false; }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function stopNativeWindows() {
  if (process.platform !== "darwin") return;
  spawnSync("pkill", ["-TERM", "-x", "AgentShellDashboard"], { stdio: "ignore" });
}

function monitorParent(close) {
  const parentPid = process.ppid;
  if (parentPid <= 1) return;
  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) return;
    clearInterval(timer);
    close().finally(() => process.exit(0));
  }, 5000);
  timer.unref();
}

function createServer(root, options) {
  return http.createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method !== "GET") return sendJson(response, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
      if (url.pathname === "/api/health") {
        return sendJson(response, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
      }
      if (url.pathname === "/api/metrics") {
        const scope = url.searchParams.get("scope") || "global";
        if (!["global", "workspace"].includes(scope)) {
          return sendJson(response, 400, { ok: false, error: "INVALID_SCOPE", allowed: ["global", "workspace"] });
        }
        const report = await metrics(root, {
          compact: true,
          limit: url.searchParams.get("limit") || 500,
          scope
        });
        return sendJson(response, 200, {
          ...report,
          dashboard: { ...report.dashboard, scope }
        });
      }
      const asset = ASSETS.get(url.pathname);
      if (!asset) return sendJson(response, 404, { ok: false, error: "NOT_FOUND" });
      return sendAsset(response, asset[0], asset[1], options);
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

function sendAsset(response, fileName, contentType, options) {
  const file = path.join(packageRoot(options), "src", "dashboard", fileName);
  if (!fs.existsSync(file)) return sendJson(response, 404, { ok: false, error: "ASSET_NOT_FOUND" });
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(fs.readFileSync(file));
}

function packageRoot(options = {}) {
  return resolvePackageRoot({
    packageRoot: options.packageRoot,
    root: options.packageRoot,
    homeDir: options.home,
    codexHome: options.codexHome,
    env: options.env,
    executablePath: options.executablePath,
    sourceRoot: options.sourceRoot,
    installedCandidates: options.installedCandidates
  });
}

function dashboardApp(options) {
  return path.join(packageRoot(options), "desktop", "macos", "dist", "AgentShell Dashboard.app");
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
