import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { targetPath, type RefactorTask } from "./models.js";
import {
  copyTree,
  hash,
  isFile,
  readJson,
  removeGenerated,
  within,
  writeJson,
} from "./utils.js";

/** Run one batch case against a private copy, including its existing tests and resources. */
export async function withBatchWorkspace<T>(
  original: RefactorTask,
  taskDir: string,
  execute: (task: RefactorTask) => Promise<T>,
): Promise<T> {
  const projectRelative = path.relative(
    original.workspace_root,
    original.project_root,
  );
  if (
    !within(original.project_root, original.workspace_root) ||
    !within(targetPath(original), original.project_root) ||
    path.isAbsolute(original.target.file_path)
  )
    throw new Error("批测目标超出数据集工作区");
  const tempParent = os.tmpdir();
  const workspace = fs.mkdtempSync(path.join(tempParent, "arkts-batch-"));
  const task = {
    ...original,
    workspace_root: workspace,
    project_root: path.join(workspace, projectRelative),
  };
  const report = path.join(taskDir, "batch-rollback.json");
  const evidence = {
    originalWorkspace: original.workspace_root,
    originalProject: original.project_root,
    privateProject: task.project_root,
    mode: "isolated-copy",
    targetFile: original.target.file_path,
    datasetCommit: original.commit_hash,
    initialTargetSha256: "",
  };
  try {
    writeJson(report, { ...evidence, cleanup: "pending" });
    // Ask the filesystem for independent copy-on-write clones where available.
    copyTree(original.project_root, task.project_root, false, fs.constants.COPYFILE_FICLONE);
    if (!isFile(targetPath(task)))
      throw new Error("隔离副本中缺少目标文件：" + original.target.file_path);
    evidence.initialTargetSha256 = hash(targetPath(task));
    writeJson(report, { ...evidence, cleanup: "pending" });
    return await execute(task);
  } finally {
    removeGenerated(workspace, tempParent);
    writeJson(report, { ...evidence, cleanup: "complete" });
  }
}

/** Signing reads local profiles from the original layout and writes only to its validation copy. */
export function signingSource(
  taskDir: string,
  source: string,
  workspaceRoot?: string,
) {
  const receipt = path.join(taskDir, "batch-rollback.json");
  if (isFile(receipt)) {
    const info = readJson(receipt);
    if (
      info.mode === "isolated-copy" &&
      workspaceRoot &&
      within(info.privateProject, workspaceRoot) &&
      within(source, info.privateProject) &&
      within(info.originalProject, info.originalWorkspace) &&
      path.relative(workspaceRoot, info.privateProject) ===
        path.relative(info.originalWorkspace, info.originalProject)
    )
      return {
        source: path.join(
          info.originalProject,
          path.relative(info.privateProject, source),
        ),
        workspaceRoot: info.originalWorkspace as string,
      };
  }
  return { source, workspaceRoot };
}
