const elements = {
  shell: document.querySelector(".shell"),
  tokens: document.querySelector("#tokens-saved"),
  timeSaved: document.querySelector("#time-saved")
};

async function refresh() {
  try {
    const response = await fetch("/api/metrics", { cache: "no-store" });
    if (!response.ok) throw new Error(`Metrics request failed: ${response.status}`);
    render(await response.json());
  } catch (error) {
    elements.tokens.textContent = "--";
    elements.timeSaved.textContent = "--";
  }
}

function render(report) {
  const dashboard = report.dashboard;
  const totals = dashboard.totals;
  const coverage = dashboard.coverage || {};
  const tokensAvailable = coverage.verifiedTokenSavingsAvailable ?? totals.estimatedContextAvoidedTokens !== null;
  const timeAvailable = coverage.verifiedTimeSavingsAvailable ?? totals.estimatedTimeSavedMs !== null;
  elements.tokens.textContent = tokensAvailable ? formatInteger(totals.estimatedContextAvoidedTokens) : "--";
  elements.timeSaved.textContent = timeAvailable ? formatDuration(totals.estimatedTimeSavedMs) : "--";
  const freshness = dashboard.freshness?.status || "unknown";
  const attribution = coverage.exactAttributionPercent == null ? "unavailable" : `${coverage.exactAttributionPercent}% exact`;
  const detail = `AgentShell local tooling. Data: ${freshness}; attribution: ${attribution}. Codex model tokens are unavailable.`;
  elements.shell.title = detail;
  elements.shell.setAttribute("aria-label", `AgentShell verified savings. ${detail}`);
}

function formatInteger(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatDuration(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

refresh();
setInterval(refresh, 5000);
