import type { Json, RefactorTask } from "../models.js";
import { LONG_METHOD_DETECTOR_RULES } from "./detector_rules.js";
import { rangeText } from "./source.js";
export const LONG_METHOD_SCOPE = [
  "默认仅修改报告目标及从它提取的新 helper；不为复用顺带修改相邻旧方法或调整业务算法。相邻方法只作上下文，不能自动扩大本轮任务。",
  "提取后检查原目标和新增 helper；若残留指向本轮顺带改过的非目标方法，先判断能否撤销那部分无关修改，再修复真正必要的变更，不继续扩展重构范围。",
  "保留原宿主、ForEach/LazyForEach 闭包、keyGenerator、索引、状态读取和修饰符链；匿名回调的报告符号不是新的可重命名公共方法。",
];
/** Detector guidance for extraction, without pretending to replace ArkAnalyzer. */
export function analyzeLongMethod(task: RefactorTask, targetText: string): Json {
  const reported = /Current:\s*(\d+)\s+(lines|statements),\s*Max:\s*(\d+)/i.exec(task.message);
  const { start_line: start, end_line: end } = task.target.range;
  const validRange = Number.isInteger(start) && Number.isInteger(end) && start! > 0 && end! >= start! && end! <= targetText.split(/\r?\n/).length;
  const fragment = validRange ? rangeText(targetText, start, end) : "";
  const inline = !!fragment && fragment.length <= 12_000;
  return {
    reportedCount: reported ? Number(reported[1]) : null,
    reportedUnit: reported ? reported[2].toLowerCase() : null,
    reportedLineCount: reported?.[2].toLowerCase() === "lines" ? Number(reported[1]) : null,
    reportedMax: reported ? Number(reported[3]) : null,
    sourceAvailable: Boolean(targetText),
    recommendedPattern: "在原 class/struct 内按职责提取私有方法或成员 @Builder",
    detectorRules: LONG_METHOD_DETECTOR_RULES,
    scopeConstraints: LONG_METHOD_SCOPE,
    targetContext: {
      startLine: start, endLine: end, inline,
      ...(inline ? { source: fragment } : { reason: validRange ? "报告范围超过 12000 字符，按目标路径与范围补读，未截断。" : "报告范围缺失或不符合当前源码，按目标符号定向定位。" }),
      scope: "重构前检测报告范围原文，仅用于定位，不证明精确方法边界、匿名回调身份或重构后计数。",
    },
    limitations: [
      "本画像不运行 ArkAnalyzer，不能证明当前方法边界、UI 分类或重构后的精确计数。",
    ],
  };
}
