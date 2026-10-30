"""Detector guidance for extraction, without pretending to replace ArkAnalyzer."""
from __future__ import annotations

import re
from typing import Any

from ..models import RefactorTask


def analyze_long_method(task: RefactorTask, target_text: str) -> dict[str, Any]:
    reported = re.search(r"Current:\s*(\d+)\s+lines,\s*Max:\s*(\d+)", task.message, re.I)
    return {
        "reportedLineCount": int(reported[1]) if reported else None,
        "reportedMax": int(reported[2]) if reported else None,
        "sourceAvailable": bool(target_text),
        "recommendedPattern": "在原 class/struct 内按职责提取私有方法或成员 @Builder",
        "detectorRules": [
            "计数基于方法源码：去掉注释后，忽略空行和仅含 { 或 } 的行；不是语句数或文件总行数。",
            "已核对的 HomeCheck 默认阈值：普通方法 50 行；UI 方法软阈值 80 行、硬阈值 120 行；严格超过阈值才报告。",
            "UI 判定包括组件 build、@Builder、关联 ViewTree 的方法及组件 UI 生命周期；不能仅凭方法名字推断。",
            "UI 超过 80 行即使只报 warning，仍属于残留异味；降到 120 行以内不等于通过。",
            "消息中的 Current/Max 是原检测证据；默认值不是所有版本或自定义配置的保证，最终以本轮 HomeCheck 为准。",
            "平台检查原目标及本轮修改/新增生产代码；原入口和新 helper 都必须避免残留长方法，不能把完整长方法搬给 helper。",
            "按完整职责拆分后核对计数并留适度余量；不得压缩多条语句到一行、删除必要注释或机械按行切片规避检测。",
        ],
        "limitations": ["本画像不运行 ArkAnalyzer，不能证明当前方法边界、UI 分类或重构后的精确计数。"],
    }
