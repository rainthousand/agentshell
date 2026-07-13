import crypto from "node:crypto";

export function sha256(text) {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}
