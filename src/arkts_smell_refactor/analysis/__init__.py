"""Smell-specific static analyzers."""

from .feature_envy import analyze_feature_envy
from .god_class import analyze_god_class
from .cyclic_dependency import analyze_cyclic_dependency
from .switch_statement import analyze_switch_statement

__all__ = [
    "analyze_cyclic_dependency",
    "analyze_feature_envy",
    "analyze_god_class",
    "analyze_switch_statement",
]
