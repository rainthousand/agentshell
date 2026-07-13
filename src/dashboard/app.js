const elements = {
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
  elements.tokens.textContent = totals.estimatedContextAvoidedTokens === null ? "--" : formatInteger(totals.estimatedContextAvoidedTokens);
  elements.timeSaved.textContent = totals.estimatedTimeSavedMs === null ? "--" : formatDuration(totals.estimatedTimeSavedMs);
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
