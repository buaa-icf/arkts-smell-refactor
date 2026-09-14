"""Smell-specific static analyzers."""

from .feature_envy import analyze_feature_envy
from .code_clone import analyze_code_clone, code_clone_risks_and_constraints
from .cyclic_dependency import analyze_cyclic_dependency
from .god_class import analyze_god_class
from .switch_statement import analyze_switch_statement

__all__ = [
    "analyze_code_clone",
    "analyze_cyclic_dependency",
    "analyze_feature_envy",
    "analyze_god_class",
    "analyze_switch_statement",
    "code_clone_risks_and_constraints",
]
