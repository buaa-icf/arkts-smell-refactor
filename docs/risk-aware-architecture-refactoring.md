# Risk-aware architecture refactoring

## Status

Draft design for review. The implementation is intentionally conservative and keeps all new behavior opt-in through task metadata or source-level risk detection.

Validation will continue on the draft branch while the questions at the end of this document are reviewed.

## Scope

This change adds three framework-level capabilities:

1. Static planning evidence for God Class tasks.
2. Directory-edge evidence for cyclic-dependency tasks.
3. A conservative public export/member compatibility gate.
4. A risk-triggered public runtime smoke gate for ordinary object construction.

The change does not introduce a planning agent, a fixed refactoring recipe, hidden tests, project-specific datasets, model selection, or experiment policies.

## Task metadata

God Class tasks need a class symbol and may use the public rule name:

```json
{
  "rule": "formal/god-class",
  "message": "God Class 'Service'",
  "filePath": "common/src/main/ets/Service.ets"
}
```

Cyclic-dependency tasks provide public graph evidence through `analysisContext`:

```json
{
  "analysisContext": {
    "module": "common",
    "modulePath": "common",
    "baselineCycles": [["apis", "models", "apis"]]
  },
  "messages": [{
    "rule": "formal/directory-cycle",
    "message": "Directory cycle"
  }]
}
```

`analysisContext` is generic task input. It does not refer to any external evaluation repository.

## God Class analysis

The analyzer records:

- fields, methods and mutable static state;
- approximate field reads and writes per method;
- candidate responsibility clusters;
- external static call sites;
- initialization, runtime-context, callback, async and state-write signals.

Clusters and candidate hints are evidence only. The refactoring agent still decides actual class boundaries from the complete source.

## Cyclic-dependency analysis

The analyzer reads declared baseline cycles and locates the corresponding relative-import edges in the target module. It records public entry files and adds constraints for:

- cutting every declared cycle;
- preserving ownership direction;
- preserving public exports and compatibility entries.

The lexical graph deliberately reports incomplete edge evidence instead of inventing an ownership decision.

## Runtime smoke gate

### Trigger

The first version runs only when all conditions hold:

- the task is a God Class with a concrete target class;
- the class has an explicit zero-argument constructor or an implicit default constructor;
- the class is importable from the module index or exported from its own source file;
- the original public source contains `getContext` or `resourceManager` risk.

Classes requiring constructor arguments, non-exported classes and unrelated tasks are skipped.

### Generated check

The framework generates a local Hypium test that:

1. constructs the public class;
2. optionally invokes one zero-argument, read-shaped public method without known side-effect signals;
3. asserts only that construction returned an instance without an immediate runtime error.

The generated test contains no expected business values. A copy is saved under `runtime-smoke-generated/` for review.

### Baseline comparison

The same generated check runs against a production-only snapshot taken before refactoring and against the current source:

- baseline fails: `BASELINE_UNAVAILABLE`, treated as `BLOCKED`, never repaired;
- baseline passes and current fails: `INTRODUCED_RUNTIME_INITIALIZATION_FAILURE`, eligible for the existing repair loop;
- both pass: gate passes.

This prevents pre-existing environment or construction limitations from being attributed to the refactoring.

## Public contract gate

Before refactoring, the framework snapshots module `Index.ets` exports and public members of exported target classes. After build it reports:

- removed export names;
- removed public fields/methods;
- changes to static/readonly status, parameter optionality/types and return/field types.

Additive members are allowed. The first version is lexical and deliberately does not guess dynamic registrations, package aliases or complex re-export semantics. Contract failures are public repair evidence.

## Pipeline integration

The contract gate runs after build. When enabled, runtime smoke follows contract and precedes existing test/linter gates. Both participate in fail-fast and repair reporting. When optional gates are not enabled, the original four-gate pipeline and review condition are unchanged.

## Known limitations

- Lexical analysis is not a type checker.
- Runtime smoke v1 does not call `init`, lifecycle hooks, async requests or methods requiring arguments.
- A passing smoke does not establish behavioral equivalence; it only detects immediate public construction regressions.
- The gate requires a runnable Local Test environment and treats an unusable baseline as infrastructure blocking.

## Review questions

1. Is `analysisContext` the right generic location for module/cycle evidence?
2. Should exported target-file imports be accepted, or should v1 require module-index exports?
3. Is the read-shaped probe selection conservative enough, or should v1 perform construction only?
4. Should runtime smoke remain between build and project tests, as implemented?
