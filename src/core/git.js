import { spawnSync } from "node:child_process";

export function gitInfo(root) {
  const branch = spawnSync("git", ["branch", "--show-current"], {
    cwd: root,
    encoding: "utf8"
  });
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8"
  });

  if (branch.status !== 0 || status.status !== 0) {
    return {
      available: false,
      branch: null,
      dirty: false,
      changedFiles: []
    };
  }

  const allChangedFiles = status.stdout
    .split("\n")
    .filter((line) => line.length >= 3)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  const changedFiles = allChangedFiles.slice(0, 10);

  return {
    available: true,
    branch: branch.stdout.trim() || null,
    dirty: allChangedFiles.length > 0,
    changedFiles,
    changedFilesTotal: allChangedFiles.length,
    changedFilesTruncated: allChangedFiles.length > changedFiles.length
  };
}
