import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDatasetTasks } from "./dataset.js";
import {
  RULE_TYPES,
  targetPath,
  type Json,
  type RefactorTask,
} from "./models.js";
import { isDir, isFile, parents, readJson, within } from "./utils.js";

export const BATCH_SMELLS = [
  "feature-envy",
  "long-method",
  "switch-statement",
  "code-clone",
] as const;
const toolRoot = parents(path.dirname(fileURLToPath(import.meta.url))).find(
  (p) =>
    isFile(path.join(p, "package.json")) &&
    readJson(path.join(p, "package.json")).name === "arkts-smell-refactor",
);
if (!toolRoot) throw new Error("无法定位 refactor 内置样例目录");
export const BATCH_INPUT_FILE = path.join(toolRoot, "data/batch-100.json");

export function loadBatch(workspace: string): {
  tasks: RefactorTask[];
  data: Json[];
  metadata: Json;
} {
  if (!isDir(workspace)) throw new Error("工作区目录不存在：" + workspace);
  const data = readJson(BATCH_INPUT_FILE) as unknown as Json[];
  if (
    !Array.isArray(data) ||
    data.length !== 100 ||
    data.some(
      (r) =>
        !["local-test", "instrument-test"].includes(r?.testKind) ||
        !Array.isArray(r?.messages) ||
        r.messages.length !== 1 ||
        (r.messages[0]?.testKind && r.messages[0].testKind !== r.testKind),
    )
  )
    throw new Error("内置100条样例清单损坏：数量或测试类型不匹配");
  const tasks = loadDatasetTasks(BATCH_INPUT_FILE, workspace);
  const smellCounts = Object.fromEntries(
    BATCH_SMELLS.map((smell) => [
      smell,
      tasks.filter((task) => task.smell_type === smell).length,
    ]),
  );
  if (
    JSON.stringify(Object.values(smellCounts)) !==
      JSON.stringify([20, 25, 25, 30]) ||
    tasks.filter((task) => task.raw.testKind === "local-test").length !== 47
  )
    throw new Error("内置100条样例清单损坏：四类异味或测试类型数量不匹配");
  for (const task of tasks) {
    if (
      !BATCH_SMELLS.includes(
        RULE_TYPES[task.rule] as (typeof BATCH_SMELLS)[number],
      )
    )
      throw new Error("内置样例规则不受支持：" + task.rule);
    if (
      !task.source_project ||
      !within(task.project_root, workspace) ||
      !within(targetPath(task), task.project_root) ||
      !isFile(targetPath(task))
    )
      throw new Error("批量样例源文件不存在或越界：" + targetPath(task));
    task.task_id = task.raw.testKind + "-" + task.task_id;
  }
  return {
    tasks,
    data,
    metadata: {
      sampleSet: "batch-100-v1",
      sampleFile: BATCH_INPUT_FILE,
      smellCounts,
      testCounts: { "local-test": 47, "instrument-test": 53 },
    },
  };
}
