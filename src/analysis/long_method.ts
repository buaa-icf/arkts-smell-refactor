import type { Json, RefactorTask } from "../models.js";
import { LONG_METHOD_DETECTOR_RULES } from "./detector_rules.js";
/** Detector guidance for extraction, without pretending to replace ArkAnalyzer. */
export function analyzeLongMethod(task: RefactorTask, targetText: string): Json {
  const reported = /Current:\s*(\d+)\s+lines,\s*Max:\s*(\d+)/i.exec(task.message);
  return {
    reportedLineCount: reported ? Number(reported[1]) : null,
    reportedMax: reported ? Number(reported[2]) : null,
    sourceAvailable: Boolean(targetText),
    recommendedPattern: "在原 class/struct 内按职责提取私有方法或成员 @Builder",
    detectorRules: LONG_METHOD_DETECTOR_RULES,
    limitations: [
      "本画像不运行 ArkAnalyzer，不能证明当前方法边界、UI 分类或重构后的精确计数。",
    ],
  };
}
