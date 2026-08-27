const elements = typeof document === "undefined" ? null : {
  shell: document.querySelector(".shell"),
  tokens: document.querySelector("#tokens-saved"),
  timeSaved: document.querySelector("#time-saved"),
  timeZone: document.querySelector("#timezone"),
  allTime: document.querySelector("#all-time"),
  daily: document.querySelector("#daily-savings")
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
  const dashboard = report.dashboard || {};
  const coverage = dashboard.coverage || {};
  const view = buildSavingsView(report);
  elements.tokens.textContent = formatEstimatedContext(view.today.contextTokens);
  elements.timeSaved.textContent = formatDuration(view.today.timeMs);
  elements.timeZone.textContent = view.timeZone;
  elements.allTime.textContent = `All time ${formatEstimatedContext(view.allTime.contextTokens)} · ${formatDuration(view.allTime.timeMs)}`;
  elements.daily.replaceChildren(...view.last7Days.map(renderDay));
  const freshness = dashboard.freshness?.status || "unknown";
  const attribution = coverage.exactAttributionPercent == null ? "unavailable" : `${coverage.exactAttributionPercent}% exact`;
  const detail = `AgentShell local tooling. Data: ${freshness}; attribution: ${attribution}. Codex model tokens are unavailable.`;
  elements.shell.title = detail;
  elements.shell.setAttribute("aria-label", `AgentShell verified savings. ${detail}`);
}

export function buildSavingsView(report) {
  const savings = report?.dashboard?.verifiedSavings;
  const availability = savings?.availability || {};
  const contextAvailable = availability.contextTokens === true;
  const timeAvailable = availability.time === true;
  const period = (value = {}) => ({
    ...(value.date ? { date: value.date } : {}),
    contextTokens: contextAvailable && isMetricValue(value.contextTokens)
      ? Number(value.contextTokens)
      : null,
    timeMs: timeAvailable && isMetricValue(value.timeMs)
      ? Number(value.timeMs)
      : null
  });
  return {
    timeZone: savings?.timeZone || "Local time",
    today: period(savings?.today),
    allTime: period(savings?.allTime),
    last7Days: Array.isArray(savings?.last7Days) ? savings.last7Days.map(period) : []
  };
}

function isMetricValue(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function renderDay(day) {
  const row = document.createElement("div");
  row.className = "day";
  const date = document.createElement("span");
  date.textContent = formatDate(day.date);
  const tokens = document.createElement("strong");
  tokens.textContent = formatEstimatedContext(day.contextTokens);
  const time = document.createElement("span");
  time.textContent = formatDuration(day.timeMs);
  row.append(date, tokens, time);
  return row;
}

function formatDate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function formatInteger(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "--";
}

function formatEstimatedContext(value) {
  const formatted = formatInteger(value);
  return formatted === "--" ? formatted : `${formatted} est. context`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "--";
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

if (elements) {
  refresh();
  setInterval(refresh, 5000);
}
