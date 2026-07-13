import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail } from "../core/output.js";
import { resolveInsideWorkspace, readJson } from "../core/workspace.js";
import { sha256 } from "../core/hash.js";
import { appendOperation, appendRunNode, ensureState, newId, readActiveRun, snapshotFilePath } from "../core/store.js";
import { suggestReplacement } from "../strategies/change-suggest.js";

export async function change(root, changeFile) {
  const changePath = resolveChangeSpec(root, changeFile);
  if (!changePath.ok) return fail(changePath.reason, `Cannot read change file: ${changeFile}`);
  if (!fs.existsSync(changePath.absTarget)) return fail("FILE_NOT_FOUND", `Change file not found: ${changeFile}`);

  const input = readJson(changePath.absTarget);
  return applyChangeInput(root, input);
}

function applyChangeInput(root, input) {
  const validation = validateInput(input);
  if (!validation.ok) return validation;

  const prepared = [];
  for (const edit of input.edits) {
    const resolved = resolveInsideWorkspace(root, edit.file);
    if (!resolved.ok) return fail(resolved.reason, `Cannot edit ${edit.file}`);
    if (!fs.existsSync(resolved.absTarget)) return fail("FILE_NOT_FOUND", `File not found: ${edit.file}`);
    if (!fs.statSync(resolved.absTarget).isFile()) return fail("NOT_A_FILE", `Not a file: ${edit.file}`);

    const original = fs.readFileSync(resolved.absTarget, "utf8");
    const actualHash = sha256(original);
    if (actualHash !== edit.expectedHash) {
      return fail("HASH_MISMATCH", "File changed since it was read", {
        file: resolved.relative,
        expectedHash: edit.expectedHash,
        actualHash
      }, [{
        command: `agentshell read ${resolved.relative} --lines ${edit.range.start}:${edit.range.end}`,
        reason: "Refresh context before editing"
      }]);
    }

    const lines = original.split(/\r?\n/);
    if (!validRange(edit.range, lines.length)) {
      return fail("INVALID_RANGE", `Invalid range for ${resolved.relative}`, {
        file: resolved.relative,
        range: edit.range,
        totalLines: lines.length
      });
    }

    const replacementLines = edit.replacement.split(/\r?\n/);
    const updatedLines = [
      ...lines.slice(0, edit.range.start - 1),
      ...replacementLines,
      ...lines.slice(edit.range.end)
    ];
    const updated = updatedLines.join("\n");
    prepared.push({ edit, resolved, original, updated });
  }

  const operationId = newId("op");
  const snapshotId = newId("snap");
  const diffSummary = { insertions: 0, deletions: 0 };
  const changedFiles = [];

  for (const item of prepared) {
    const oldLines = item.original.split(/\r?\n/).length;
    const newLines = item.updated.split(/\r?\n/).length;
    diffSummary.insertions += Math.max(0, newLines - oldLines);
    diffSummary.deletions += Math.max(0, oldLines - newLines);
    changedFiles.push(item.resolved.relative);
  }

  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      changedFiles,
      diffSummary
    };
  }

  ensureState(root);
  for (const item of prepared) {
    const snapshotPath = snapshotFilePath(root, snapshotId, item.resolved.relative);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, item.original);
    fs.writeFileSync(item.resolved.absTarget, item.updated);
  }

  appendOperation(root, {
    id: operationId,
    type: "change",
    ok: true,
    reason: input.reason || null,
    snapshotId,
    changedFiles,
    diffSummary
  });

  return {
    ok: true,
    operationId,
    snapshotId,
    changedFiles,
    diffSummary,
    suggestedNextActions: [{
      command: "agentshell verify test",
      reason: "Validate the change"
    }]
  };
}

export async function fillChange(root, templateFile, fillFile, options = {}) {
  const templatePath = resolveChangeSpec(root, templateFile);
  if (!templatePath.ok) return fail(templatePath.reason, `Cannot read change template: ${templateFile}`);
  if (!fs.existsSync(templatePath.absTarget)) return fail("FILE_NOT_FOUND", `Change template not found: ${templateFile}`);

  const fillPath = resolveFillSpec(root, fillFile);
  if (!fillPath.ok) return fail(fillPath.reason, `Cannot read fill file: ${fillFile}`);
  if (!fs.existsSync(fillPath.absTarget)) return fail("FILE_NOT_FOUND", `Fill file not found: ${fillFile}`);

  const template = readJson(templatePath.absTarget);
  const fill = readJson(fillPath.absTarget);
  const validation = validateFill(template, fill);
  if (!validation.ok) return validation;

  if (typeof fill.reason === "string") template.reason = fill.reason;
  if (typeof fill.replacement === "string") {
    template.edits[fill.editIndex || 0].replacement = fill.replacement;
  }
  if (Array.isArray(fill.replacements)) {
    fill.replacements.forEach((replacement, index) => {
      template.edits[index].replacement = replacement;
    });
  }

  fs.writeFileSync(templatePath.absTarget, `${JSON.stringify(template, null, 2)}\n`);

  const output = {
    ok: true,
    template: templatePath.relative || templateFile,
    filledEdits: template.edits.filter((edit) => edit.replacement !== "").length,
    totalEdits: template.edits.length,
    suggestedNextActions: [{
      command: `agentshell change ${templatePath.relative || templateFile}`,
      reason: "Apply the filled hash-checked change"
    }]
  };

  if (!options.apply) return output;

  const applied = applyChangeInput(root, template);
  const activeRun = readActiveRun(root);
  if (activeRun) {
    appendRunNode(root, activeRun.id, {
      type: "change",
      ok: applied.ok,
      operationId: applied.operationId || null,
      template: output.template,
      changedFiles: applied.changedFiles || [],
      diffSummary: applied.diffSummary || null
    });
  }
  return {
    ok: applied.ok,
    runId: activeRun?.id || null,
    template: output.template,
    filledEdits: output.filledEdits,
    totalEdits: output.totalEdits,
    applied: summarizeAppliedChange(applied)
  };
}

export async function suggestChange(root, options = {}) {
  const activeRun = readActiveRun(root);
  const diagnosis = activeRun?.nodes?.find((node) => node.type === "diagnose");
  const unsupportedReason = missingSuggestionReason(activeRun, diagnosis);
  if (unsupportedReason) {
    return fail("NO_CHANGE_SUGGESTION", "No active diagnosis with a change template found", {
      unsupportedReason
    }, [{
      command: "agentshell diagnose test --compact",
      reason: "Create a diagnosis and change template first"
    }]);
  }

  const templateFile = diagnosis.changeTemplate.path;
  const templatePath = resolveChangeSpec(root, templateFile);
  if (!templatePath.ok || !fs.existsSync(templatePath.absTarget)) {
    return fail("TEMPLATE_NOT_FOUND", `Change template not found: ${templateFile}`);
  }

  const template = readJson(templatePath.absTarget);
  const validation = validateInput(template);
  if (!validation.ok) return validation;

  const edit = template.edits[0];
  const resolved = resolveInsideWorkspace(root, edit.file);
  if (!resolved.ok) return fail(resolved.reason, `Cannot read ${edit.file}`);
  if (!fs.existsSync(resolved.absTarget)) return fail("FILE_NOT_FOUND", `File not found: ${edit.file}`);

  const original = fs.readFileSync(resolved.absTarget, "utf8");
  const actualHash = sha256(original);
  if (actualHash !== edit.expectedHash) {
    return fail("HASH_MISMATCH", "File changed since the template was generated", {
      file: resolved.relative,
      expectedHash: edit.expectedHash,
      actualHash
    }, [{
      command: `agentshell diagnose test --compact`,
      reason: "Refresh diagnosis and change template"
    }]);
  }

  const suggestion = suggestReplacement(root, original, edit.range, diagnosis);
  if (!suggestion) {
    return fail("SUGGESTION_UNAVAILABLE", "No safe replacement suggestion available", {
      template: templatePath.relative || templateFile,
      unsupportedReason: "unsupported-pattern"
    }, [{
      command: `agentshell change fill ${templatePath.relative || templateFile} <fill.json> --apply`,
      reason: "Fill the generated template manually"
    }]);
  }

  const { replacement, strategy } = suggestion;
  const fillPath = writeSuggestedFill(root, replacement, template.reason);
  const dryRun = Boolean(options.dryRun) || !options.apply;
  const output = {
    ok: true,
    compact: Boolean(options.compact),
    dryRun,
    runId: activeRun.id,
    template: templatePath.relative || templateFile,
    fill: fillPath,
    confidence: diagnosis.fixPlan.confidence || "low",
    strategy,
    preview: {
      file: edit.file,
      range: edit.range,
      fill: fillPath
    },
    suggestedNextActions: [{
      command: `agentshell change fill ${templatePath.relative || templateFile} ${fillPath} --apply`,
      reason: "Apply the suggested hash-checked change"
    }]
  };
  if (!options.compact) output.replacement = replacement;

  if (dryRun) return output;

  const preparedTemplate = {
    ...template,
    reason: template.reason || null,
    edits: template.edits.map((item, index) => index === 0
      ? { ...item, replacement }
      : item)
  };
  const applied = applyChangeInput(root, preparedTemplate);
  if (!applied.ok) {
    return {
      ...output,
      ok: false,
      applied
    };
  }
  const activeRunAfterApply = readActiveRun(root);
  if (activeRunAfterApply) {
    appendRunNode(root, activeRunAfterApply.id, {
      type: "change",
      ok: applied.ok,
      operationId: applied.operationId || null,
      template: templatePath.relative || templateFile,
      changedFiles: applied.changedFiles || [],
      diffSummary: applied.diffSummary || null
    });
  }

  return {
    ...output,
    applied: summarizeAppliedChange(applied),
    suggestedNextActions: [{
      command: "agentshell verify test",
      reason: "Validate the suggested change"
    }]
  };
}

function missingSuggestionReason(activeRun, diagnosis) {
  if (!activeRun || !diagnosis) return "no-active-diagnosis";
  if (!diagnosis.changeTemplate?.path) return "no-change-template";
  if (!diagnosis.fixPlan?.target) return "ambiguous-target";
  return null;
}

function summarizeAppliedChange(applied) {
  if (!applied.ok) return applied;
  return {
    ok: true,
    operationId: applied.operationId,
    changedFiles: applied.changedFiles,
    diffSummary: applied.diffSummary
  };
}

function writeSuggestedFill(root, replacement, reason) {
  const dir = ensureState(root);
  const fillId = newId("fill");
  const absFile = path.join(dir, "change-templates", `${fillId}.json`);
  const payload = { replacement };
  if (reason) payload.reason = reason;
  fs.writeFileSync(absFile, `${JSON.stringify(payload, null, 2)}\n`);
  return path.relative(root, absFile);
}

function validateInput(input) {
  if (!input || !Array.isArray(input.edits) || input.edits.length === 0) {
    return fail("INVALID_CHANGE", "Change file must include a non-empty edits array");
  }
  for (const edit of input.edits) {
    if (!edit.file || !edit.expectedHash || !edit.range || typeof edit.replacement !== "string") {
      return fail("INVALID_CHANGE", "Each edit needs file, expectedHash, range, and replacement");
    }
    if (!Number.isInteger(edit.range.start) || !Number.isInteger(edit.range.end)) {
      return fail("INVALID_RANGE", "Edit range must include integer start and end");
    }
  }
  return { ok: true };
}

function validateFill(template, fill) {
  const templateValidation = validateInput(template);
  if (!templateValidation.ok) return templateValidation;
  if (!fill || typeof fill !== "object") {
    return fail("INVALID_FILL", "Fill file must be a JSON object");
  }
  if (typeof fill.replacement !== "string" && !Array.isArray(fill.replacements)) {
    return fail("INVALID_FILL", "Fill file must include replacement or replacements");
  }
  if (fill.editIndex !== undefined && (!Number.isInteger(fill.editIndex) || fill.editIndex < 0 || fill.editIndex >= template.edits.length)) {
    return fail("INVALID_FILL", "editIndex must reference an existing edit");
  }
  if (Array.isArray(fill.replacements)) {
    if (fill.replacements.length !== template.edits.length) {
      return fail("INVALID_FILL", "replacements length must match template edits length");
    }
    if (!fill.replacements.every((replacement) => typeof replacement === "string")) {
      return fail("INVALID_FILL", "Every replacement must be a string");
    }
  }
  return { ok: true };
}

function validRange(range, totalLines) {
  return range.start >= 1 && range.end >= range.start && range.end <= totalLines;
}

function resolveChangeSpec(root, changeFile) {
  const workspacePath = resolveInsideWorkspace(root, changeFile);
  if (workspacePath.ok) return workspacePath;

  const absTarget = path.resolve(root, changeFile);
  const workspaceTemplate = resolveWorkspaceChangeTemplate(root, absTarget);
  if (workspaceTemplate.ok) return workspaceTemplate;

  const tmpRoot = path.resolve(os.tmpdir());
  const relativeToTmp = path.relative(tmpRoot, absTarget);
  if (!relativeToTmp.startsWith("..") && !path.isAbsolute(relativeToTmp)) {
    return {
      ok: true,
      absRoot: tmpRoot,
      absTarget,
      relative: relativeToTmp
    };
  }

  return workspacePath;
}

function resolveFillSpec(root, fillFile) {
  const workspacePath = resolveInsideWorkspace(root, fillFile);
  if (workspacePath.ok) return workspacePath;

  const absTarget = path.resolve(root, fillFile);
  const workspaceTemplate = resolveWorkspaceChangeTemplate(root, absTarget);
  if (workspaceTemplate.ok) return workspaceTemplate;

  const tmpRoot = path.resolve(os.tmpdir());
  const relativeToTmp = path.relative(tmpRoot, absTarget);
  if (!relativeToTmp.startsWith("..") && !path.isAbsolute(relativeToTmp)) {
    return {
      ok: true,
      absRoot: tmpRoot,
      absTarget,
      relative: relativeToTmp
    };
  }

  return workspacePath;
}

function resolveWorkspaceChangeTemplate(root, absTarget) {
  const absRoot = path.resolve(root);
  const relative = path.relative(absRoot, absTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: "FILE_OUTSIDE_WORKSPACE" };
  }

  const allowedRoot = path.join(".agentshell", "change-templates");
  const relativeToTemplates = path.relative(allowedRoot, relative);
  if (relativeToTemplates.startsWith("..") || path.isAbsolute(relativeToTemplates)) {
    return { ok: false, reason: "DENIED_PATH" };
  }
  if (path.extname(relative) !== ".json") {
    return { ok: false, reason: "DENIED_PATH" };
  }

  return {
    ok: true,
    absRoot,
    absTarget,
    relative
  };
}
