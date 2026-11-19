import type { Issue } from "./client/types.js";

const smellNames: Record<string, string> = {
  "feature-envy": "依恋情结",
  "long-method": "过长方法",
  "switch-statement": "Switch 分支",
  "code-clone": "重复代码",
};

function choiceLabel(issue: Issue, index: number): string {
  return `#${index + 1} ${smellNames[issue.smellType] ?? issue.smellType}`;
}

/** DevEco returns the selected label. Number all findings, including read-only ones. */
export function issueQuestion(issues: Issue[]) {
  const options = issues.flatMap((issue, index) => {
    if (!issue.supported) return [];
    const lines = issue.startLine === issue.endLine ? String(issue.startLine) : `${issue.startLine}–${issue.endLine}`;
    const location = `${issue.filePath}:${lines}`;
    return [{
      label: choiceLabel(issue, index),
      description: issue.symbol ? `${location} · ${issue.symbol}` : location,
    }];
  });
  if (!options.length) return null;
  options.push({ label: "仅查看结果", description: "结束本次检测" });
  return { questions: [{
    header: "选择异味",
    question: "你想先重构哪一项？",
    multiple: false,
    options,
  }] };
}

export function issueForChoice(issues: Issue[], choice: string): Issue | undefined {
  return issues.find((issue, index) =>
    issue.supported && (choice === String(index + 1) || choice === choiceLabel(issue, index)),
  );
}
