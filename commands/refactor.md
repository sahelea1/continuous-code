---
description: Plan and execute a refactoring
subtask: true
---

You are running the /refactor workflow. This pipeline plans a safe refactoring, reviews the plan, implements changes while keeping tests green, then verifies nothing broke.

## Context

What to refactor: $ARGUMENTS

## Pipeline

Execute the following pipeline in order:

### Step 1: Plan with phoenix

Use the task tool to spawn a **phoenix** agent:

```
Create a refactoring plan for: $ARGUMENTS

A refactoring must not change observable behavior — only internal structure.

Your plan must include:
1. Current state — what exists now and what problems it has
2. Target state — what the code should look like after refactoring
3. Step-by-step migration path — small, safe incremental steps
4. Impact analysis — what files and call sites are affected
5. Test strategy — how to verify behavior is preserved at each step
6. Rollback plan — how to revert if something goes wrong

Impact analysis (use what is available):
- If `tldr` is on PATH (extras.tldr): run `tldr impact <target> . --depth 3` to identify all callers.
- Otherwise fall back to native tools: Grep for call-site search, Read for file-by-file tracing.

Output a numbered step list where each step is independently committable.
```

### Step 2: Review the plan with judge

Using the refactoring plan from Step 1, spawn a **judge** agent:

```
Review this refactoring plan before implementation begins:

[Refactoring target]: $ARGUMENTS

[Plan from phoenix]: {phoenix output}

Evaluate:
1. Safety — does each step preserve observable behavior?
2. Completeness — are all call sites and dependents accounted for?
3. Step size — are steps small enough to be safe and reviewable?
4. Test coverage — will existing tests catch regressions?
5. Risk — what could go wrong, and is the rollback plan sufficient?

Flag any concerns as BLOCKER (must address before proceeding) or WARNING (proceed with caution).

If the plan is safe to proceed, say so explicitly.
```

### Step 3: Implement with kraken

After the judge approves the plan (address any BLOCKERs first), spawn a **kraken** agent:

```
Execute this refactoring step by step:

[Refactoring target]: $ARGUMENTS

[Approved plan from phoenix]: {phoenix output}
[Review notes from judge]: {judge output}

Rules:
1. Follow the plan steps in order — do not skip or reorder
2. Run the full test suite after EACH step
3. If any test fails after a step, stop and report — do not continue
4. Do not change behavior — only structure
5. Do not add new features during the refactor

After completing all steps, run the full test suite one final time and report results.
```

### Step 4: Verify with arbiter

Spawn an **arbiter** agent for final verification:

```
Verify the refactoring of: $ARGUMENTS

[Implementation from kraken]: {kraken output}

Confirm:
1. Full test suite passes with zero failures
2. No regressions introduced (compare test count before and after if possible)
3. Type checks pass on refactored files
4. Linting passes on refactored files
5. The refactored code is functionally equivalent to the original

Report: PASS or FAIL with evidence.
```

## Output

After all steps complete, summarize:
- What was refactored
- Steps executed
- Files changed
- Test results (before and after)
- Any warnings from the judge that were addressed
