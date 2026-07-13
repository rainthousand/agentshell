#!/usr/bin/env python3
"""Rewrite the plugin version with a fresh Codex cachebuster suffix."""

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("plugin_path")
    parser.add_argument("--cachebuster")
    args = parser.parse_args()

    manifest_path = Path(args.plugin_path).resolve() / ".codex-plugin" / "plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = manifest.get("version")
    if not isinstance(version, str) or not version.strip():
        raise ValueError("plugin manifest must contain a non-empty version")

    raw = args.cachebuster or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    cachebuster = re.sub(r"[^a-z0-9-]+", "-", raw.strip().lower()).strip("-")
    if not cachebuster:
        raise ValueError("cachebuster must contain a letter or digit")

    manifest["version"] = f"{version.split('+', 1)[0]}+codex.{cachebuster}"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Updated plugin version: {version} -> {manifest['version']}")


if __name__ == "__main__":
    main()
