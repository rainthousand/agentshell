import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_RELEASE_CHANNEL = "stable";
export const DEFAULT_RELEASE_REPOSITORY = "rainthousand/agentshell";
export const RELEASE_CHANNELS = new Set(["stable", "beta"]);

const PLUGIN_ASSET = "agentshell-codex-plugin.zip";
const CHECKSUM_ASSET = `${PLUGIN_ASSET}.sha256`;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;

export class ReleaseChannelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReleaseChannelError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeReleaseChannel(value = DEFAULT_RELEASE_CHANNEL) {
  const channel = String(value || "").toLowerCase();
  if (!RELEASE_CHANNELS.has(channel)) {
    throw new ReleaseChannelError("INVALID_RELEASE_CHANNEL", "Release channel must be stable or beta.", { channel: value });
  }
  return channel;
}

export async function acquireReleasePackage(options = {}) {
  const channel = normalizeReleaseChannel(options.channel);
  const repository = options.repository || DEFAULT_RELEASE_REPOSITORY;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ReleaseChannelError("RELEASE_FETCH_UNAVAILABLE", "This runtime cannot download GitHub releases.");
  }

  const githubToken = resolveGitHubToken(options);
  const release = await fetchRelease({ ...options, channel, repository, fetchImpl, githubToken });
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const archiveAsset = assets.find((asset) => asset?.name === PLUGIN_ASSET);
  const checksumAsset = assets.find((asset) => asset?.name === CHECKSUM_ASSET);
  if (!assetUrl(archiveAsset) || !assetUrl(checksumAsset)) {
    throw new ReleaseChannelError("RELEASE_ASSET_MISSING", `GitHub release ${release.tag_name} is missing ${PLUGIN_ASSET} or its checksum.`, {
      tag: release.tag_name,
      requiredAssets: [PLUGIN_ASSET, CHECKSUM_ASSET]
    });
  }

  const temporaryRoot = fs.mkdtempSync(path.join(options.temporaryDirectory || os.tmpdir(), "agentshell-release-"));
  try {
    const checksumText = await fetchText(assetUrl(checksumAsset), {
      ...options,
      fetchImpl,
      githubToken,
      repository,
      accept: "application/octet-stream"
    });
    const expectedSha256 = parseChecksum(checksumText, PLUGIN_ASSET);
    const archive = path.join(temporaryRoot, PLUGIN_ASSET);
    const bytes = await fetchBytes(assetUrl(archiveAsset), {
      ...options,
      fetchImpl,
      githubToken,
      repository,
      accept: "application/octet-stream"
    });
    const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new ReleaseChannelError("RELEASE_CHECKSUM_MISMATCH", "Downloaded AgentShell release failed SHA-256 verification.", {
        expectedSha256,
        actualSha256,
        asset: PLUGIN_ASSET
      });
    }
    writeFileAtomic(archive, bytes, 0o600);

    const extracted = path.join(temporaryRoot, "extracted");
    fs.mkdirSync(extracted, { recursive: true, mode: 0o700 });
    if (options.extractArchive) await options.extractArchive(archive, extracted);
    else extractZipSafely(archive, extracted, options.runCommand);
    assertExtractedTreeSafe(extracted);
    const source = findPackageRoot(extracted);
    const manifest = readJson(path.join(source, ".codex-plugin", "plugin.json"));
    if (manifest?.name !== "agentshell" || !manifest.version) {
      throw new ReleaseChannelError("RELEASE_PACKAGE_INVALID", "The verified release archive does not contain a valid AgentShell plugin.");
    }
    const tagVersion = String(release.tag_name || "").replace(/^v/u, "");
    const packageVersion = String(manifest.version).split("+")[0];
    if (!tagVersion || packageVersion !== tagVersion) {
      throw new ReleaseChannelError("RELEASE_VERSION_MISMATCH", "Release tag and plugin package version do not match.", {
        tag: release.tag_name || null,
        packageVersion
      });
    }

    return {
      source,
      cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
      status: {
        ok: true,
        status: "verified",
        channel,
        source: "github-release",
        repository,
        tag: release.tag_name,
        version: packageVersion,
        prerelease: Boolean(release.prerelease),
        asset: PLUGIN_ASSET,
        bytes: bytes.length,
        sha256: actualSha256,
        checksumVerified: true,
        dataUploaded: false
      }
    };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function fetchRelease(options) {
  const apiBase = String(options.apiBase || "https://api.github.com").replace(/\/$/u, "");
  if (options.channel === "stable") {
    const release = await fetchJson(`${apiBase}/repos/${options.repository}/releases/latest`, options);
    if (release?.draft || release?.prerelease) {
      throw new ReleaseChannelError("STABLE_RELEASE_INVALID", "GitHub returned a draft or prerelease for the stable channel.");
    }
    return release;
  }

  const releases = await fetchJson(`${apiBase}/repos/${options.repository}/releases?per_page=30`, options);
  const release = Array.isArray(releases) ? releases.find((item) => !item?.draft && item?.prerelease) : null;
  if (!release) throw new ReleaseChannelError("BETA_RELEASE_NOT_FOUND", "No published prerelease is available on the beta channel.");
  return release;
}

async function fetchJson(url, options) {
  const response = await request(url, options);
  try {
    return await response.json();
  } catch {
    throw new ReleaseChannelError("RELEASE_RESPONSE_INVALID", "GitHub returned invalid release metadata.", { url });
  }
}

async function fetchText(url, options) {
  const response = await request(url, options);
  return response.text();
}

async function fetchBytes(url, options) {
  const response = await request(url, options);
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
    throw new ReleaseChannelError("RELEASE_ASSET_TOO_LARGE", "Release asset exceeds the installer size limit.", { bytes: declared });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new ReleaseChannelError("RELEASE_ASSET_TOO_LARGE", "Release asset exceeds the installer size limit.", { bytes: bytes.length });
  }
  return bytes;
}

async function request(url, options) {
  const headers = {
    Accept: options.accept || "application/vnd.github+json",
    "User-Agent": "AgentShell-Installer",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const token = options.githubToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await options.fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: options.signal || AbortSignal.timeout(options.timeoutMs || 30_000)
    });
  } catch (error) {
    throw new ReleaseChannelError("RELEASE_DOWNLOAD_FAILED", `Could not reach GitHub: ${error.message}`, { url });
  }
  if (!response?.ok) {
    throw new ReleaseChannelError("RELEASE_HTTP_ERROR", `GitHub release request failed with HTTP ${response?.status ?? "unknown"}.`, {
      url,
      status: response?.status ?? null
    });
  }
  return response;
}

function assetUrl(asset) {
  return asset?.url || asset?.browser_download_url;
}

function resolveGitHubToken(options) {
  const configured = options.githubToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (configured || options.fetchImpl || options.useGhAuth === false) return configured || null;
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function parseChecksum(text, expectedAsset) {
  for (const line of String(text).split(/\r?\n/u)) {
    const match = line.trim().match(/^([a-f0-9]{64})(?:\s+\*?(.+))?$/iu);
    if (!match) continue;
    const filename = match[2] ? path.basename(match[2].trim()) : expectedAsset;
    if (filename === expectedAsset) return match[1].toLowerCase();
  }
  throw new ReleaseChannelError("RELEASE_CHECKSUM_INVALID", `Checksum asset does not contain a SHA-256 value for ${expectedAsset}.`);
}

function extractZipSafely(archive, destination, runner = spawnSync) {
  const listed = runner("unzip", ["-Z1", archive], { encoding: "utf8" });
  if (listed?.status !== 0) throw new ReleaseChannelError("RELEASE_ARCHIVE_INVALID", "Release archive could not be inspected.");
  const unsafe = String(listed.stdout || "").split(/\r?\n/u).filter(Boolean).find((entry) => {
    const normalized = entry.replaceAll("\\", "/");
    return normalized.startsWith("/") || normalized.split("/").includes("..");
  });
  if (unsafe) throw new ReleaseChannelError("RELEASE_ARCHIVE_UNSAFE", "Release archive contains an unsafe path.", { entry: unsafe });

  const extracted = runner("unzip", ["-q", archive, "-d", destination], { encoding: "utf8" });
  if (extracted?.status !== 0) throw new ReleaseChannelError("RELEASE_ARCHIVE_INVALID", "Release archive could not be extracted.");
}

function findPackageRoot(directory) {
  const direct = path.join(directory, ".codex-plugin", "plugin.json");
  if (fs.existsSync(direct)) return directory;
  const candidates = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
    .filter((candidate) => fs.existsSync(path.join(candidate, ".codex-plugin", "plugin.json")));
  if (candidates.length !== 1) {
    throw new ReleaseChannelError("RELEASE_PACKAGE_INVALID", "Release archive must contain exactly one AgentShell package root.");
  }
  return candidates[0];
}

function assertExtractedTreeSafe(directory) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const metadata = fs.lstatSync(candidate);
      if (metadata.isSymbolicLink()) {
        throw new ReleaseChannelError("RELEASE_ARCHIVE_UNSAFE", "Release archive contains a symbolic link.", {
          entry: path.relative(directory, candidate)
        });
      }
      if (metadata.isDirectory()) pending.push(candidate);
      else if (!metadata.isFile()) {
        throw new ReleaseChannelError("RELEASE_ARCHIVE_UNSAFE", "Release archive contains an unsupported file type.", {
          entry: path.relative(directory, candidate)
        });
      }
    }
  }
}

function writeFileAtomic(file, content, mode) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
