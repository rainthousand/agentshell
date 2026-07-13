export function printJson(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  process.stdout.write(text);
  return text.length;
}

export function fail(code, message, details = {}, suggestedNextActions = []) {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
      suggestedNextActions
    }
  };
}
