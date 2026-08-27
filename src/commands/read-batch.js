import {
  readFileAround,
  readFileHead,
  readFileRange,
  readFileTail
} from "./read.js";
import { executeBatchReads, parseBatchTarget } from "../core/batch-read.js";

export { parseBatchTarget };

export async function readBatch(root, targets, options = {}) {
  return executeBatchReads(targets, (target, readOptions) => readOne(root, target, readOptions), options);
}

function readOne(root, target, readOptions) {
  if (target.mode === "lines") return readFileRange(root, target.file, target.value, readOptions);
  if (target.mode === "around") return readFileAround(root, target.file, target.value, readOptions);
  if (target.mode === "head") return readFileHead(root, target.file, target.value, readOptions);
  return readFileTail(root, target.file, target.value, readOptions);
}
