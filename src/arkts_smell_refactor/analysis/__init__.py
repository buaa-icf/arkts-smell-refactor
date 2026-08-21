"""Smell-specific static analyzers."""

from .feature_envy import analyze_feature_envy
from .switch_statement import analyze_switch_statement

__all__ = ["analyze_feature_envy", "analyze_switch_statement"]
