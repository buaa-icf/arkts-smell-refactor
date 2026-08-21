"""Backward-compatible import; analyzers now live under arkts_smell_refactor.analysis."""

from .analysis.switch_statement import analyze_switch_statement

__all__ = ["analyze_switch_statement"]
