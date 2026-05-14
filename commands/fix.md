---
description: Investigate and fix a bug
subtask: true
---

You are running the /fix workflow. Your job is to investigate a bug, implement a fix, verify it with tests, and create a handoff.

## Context

Bug or issue to fix: $ARGUMENTS

## Pipeline

Execute the following pipeline in order:

### Step 1: Investigate with sleuth

Use the task tool to spawn a **sleuth** agent with this prompt:

```
Investigate this bug thoroughly:

$ARGUMENTS

Perform parallel investigation across:
1. Relevant source files and recent changes (git log, git diff)
2. Error messages, stack traces, and logs
3. Test failures and test output
4. Related code paths that could be the root cause

Return a structured diagnosis:
- Root cause hypothesis
- Supporting evidence (file:line references)
- Affected files
- Proposed fix approach
- Risk assessment (low/medium/high)
```

### Step 2: Implement with kraken

Using the sleuth diagnosis from Step 1, spawn a **kraken** agent:

```
Implement a fix for this bug:

[Bug]: $ARGUMENTS

[Diagnosis from sleuth]: {sleuth output}

Requirements:
1. Write a failing regression test first that reproduces the bug
2. Implement the minimal fix to make the test pass
3. Run the full test suite to confirm nothing is broken
4. Follow existing code patterns and style

Do not add features beyond what is needed to fix the bug.
```

### Step 3: Verify with arbiter

Spawn an **arbiter** agent to verify:

```
Verify the bug fix for: $ARGUMENTS

[Implementation from kraken]: {kraken output}

Run:
1. The new regression test — it must pass
2. The full test suite — no regressions allowed
3. Any type checks or linting relevant to changed files

Report: pass/fail with evidence.
```

### Step 4: Create handoff with scribe

Spawn a **scribe** agent:

```
Create a session handoff documenting the bug fix for: $ARGUMENTS

Include:
- Root cause found by sleuth
- Files modified by kraken
- Test results from arbiter
- Status: complete/partial/blocked
- Any follow-up needed

Write to: thoughts/shared/handoffs/<session-slug>/<timestamp>.yaml

Also update the continuity ledger at thoughts/shared/CONTINUITY.md if it exists.
```

## Output

After all steps complete, summarize:
- What the bug was
- What the root cause was
- What was changed (files and lines)
- Test results
- Handoff location
