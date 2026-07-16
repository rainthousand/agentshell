#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ffmpeg = process.env.FFMPEG || "ffmpeg";
const outputDir = path.join(root, "docs", "images");
const frameDir = path.join(root, "artifacts", "marketing-frames");

if (!fs.existsSync(chrome)) throw new Error(`Google Chrome is required: ${chrome}`);
fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(frameDir, { recursive: true, force: true });
fs.mkdirSync(frameDir, { recursive: true });

capture("assets/marketing/social-preview.html", path.join(outputDir, "social-preview.png"), "1280,640");
for (const frame of [1, 2, 3]) {
  capture(
    `assets/marketing/demo.html?frame=${frame}`,
    path.join(frameDir, `frame-${frame}.png`),
    "1200,675"
  );
}

run(ffmpeg, [
  "-y", "-framerate", "0.65", "-i", path.join(frameDir, "frame-%d.png"),
  "-vf", "fps=12,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
  "-loop", "0", path.join(outputDir, "agentshell-benchmark.gif")
]);

const socialSize = fs.statSync(path.join(outputDir, "social-preview.png")).size;
if (socialSize >= 1_000_000) throw new Error(`Social preview exceeds GitHub's 1 MB limit: ${socialSize}`);

console.log(JSON.stringify({
  ok: true,
  socialPreview: "docs/images/social-preview.png",
  benchmarkGif: "docs/images/agentshell-benchmark.gif",
  socialPreviewBytes: socialSize
}, null, 2));

function capture(relativeUrl, output, windowSize) {
  const [relativePath, query = ""] = relativeUrl.split("?");
  const url = `${pathToFileURL(path.join(root, relativePath)).href}${query ? `?${query}` : ""}`;
  run(chrome, [
    "--headless=new", "--hide-scrollbars", "--disable-gpu",
    `--window-size=${windowSize}`, `--screenshot=${output}`, url
  ]);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}
