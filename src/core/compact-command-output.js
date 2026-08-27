const SECRET_PATTERNS = [
  /(authorization\s*:\s*bearer\s+)[^\s]+/gi,
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[=:]\s*)[^\s,;]+/gi,
  /(https?:\/\/[^\s:/]+:)[^@\s]+(@)/gi
];

const MAX_PREVIEW_CHARS = 900;
const MAX_PREVIEW_LINES = 8;

export function redactCommandOutput(value) {
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, (_match, prefix, suffix = "") => `${prefix}[REDACTED]${suffix}`),
    stripControlCharacters(String(value || ""))
  );
}

export function compactOutputPreview(stdout, stderr, options = {}) {
  const source = options.preferStderr && stderr.trim() ? stderr : (stdout.trim() ? stdout : stderr);
  const lines = redactCommandOutput(source)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  const selected = lines.length <= MAX_PREVIEW_LINES
    ? lines
    : [...lines.slice(0, 2), `... ${lines.length - 6} lines omitted ...`, ...lines.slice(-4)];
  return limitText(selected.join("\n"), MAX_PREVIEW_CHARS);
}

export function compactEvidence(errors, limit = 5) {
  return errors.slice(0, limit).map((error) => ({
    message: limitText(redactCommandOutput(error.message), 180),
    type: error.type,
    file: error.file,
    line: error.line,
    column: error.column,
    confidence: error.confidence
  }));
}

export function clipUtf8Bytes(value, maxBytes) {
  const buffer = Buffer.from(String(value || ""), "utf8");
  if (buffer.length <= maxBytes) return String(value || "");
  return buffer.subarray(0, Math.max(0, maxBytes)).toString("utf8").replace(/\uFFFD$/, "");
}

function stripControlCharacters(value) {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function limitText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
