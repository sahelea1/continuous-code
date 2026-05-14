---
description: Multi-perspective code review
subtask: true
---

You are running the /review workflow. This spawns three specialist reviewers in parallel — a quality judge, a test auditor, and a codebase scout — then synthesizes their findings into a unified review.

## Context

Code to review: $ARGUMENTS

If $ARGUMENTS specifies a file, PR, branch, or feature name, focus the review there. If empty, review recent changes (git diff HEAD or staged changes).

## Pipeline

### Step 1: Parallel review

Call `parallel_delegate` with the following array of `{agent, prompt}` pairs to spawn all three reviewers simultaneously:

```json
[
  {
    "agent": "judge",
    "prompt": "Perform a thorough code quality review.\n\nTarget: $ARGUMENTS (or recent changes if not specified)\n\nEvaluate:\n1. Correctness — does the code do what it intends?\n2. Code quality — is it readable, well-named, and maintainable?\n3. Design — does it follow SOLID principles and existing patterns?\n4. Security — any injection risks, auth issues, data exposure?\n5. Performance — any obvious bottlenecks or inefficiencies?\n6. Error handling — are edge cases and failures handled?\n\nFor each issue found, classify as:\n- BLOCKER: Must fix before merging\n- WARNING: Should fix, but not blocking\n- SUGGESTION: Nice to have improvement\n\nInclude file:line references for all issues."
  },
  {
    "agent": "arbiter",
    "prompt": "Audit the tests for the code under review.\n\nTarget: $ARGUMENTS (or recent changes if not specified)\n\nEvaluate:\n1. Coverage — are the important behaviors tested?\n2. Quality — do tests actually verify behavior (not just run code)?\n3. Naming — do test names describe what is being tested?\n4. Isolation — are tests independent and repeatable?\n5. Edge cases — are failure paths and boundaries tested?\n6. Missing tests — what behaviors lack test coverage?\n\nRun the test suite and report results.\n\nFor each issue found, classify as:\n- BLOCKER: Critical gap in coverage or broken tests\n- WARNING: Tests exist but have quality issues\n- SUGGESTION: Additional coverage would be beneficial\n\nInclude file:line references for all issues."
  },
  {
    "agent": "scout",
    "prompt": "Review how well the code fits the existing codebase.\n\nTarget: $ARGUMENTS (or recent changes if not specified)\n\nEvaluate:\n1. Pattern consistency — does the code match existing patterns and conventions?\n2. Naming consistency — do names follow the project's conventions?\n3. Structural fit — is the code placed in the right location?\n4. Duplication — does it reimplement something that already exists?\n5. Documentation — are public interfaces documented appropriately?\n6. Dependencies — are any new dependencies introduced and are they appropriate?\n\nFor each issue found, classify as:\n- BLOCKER: Fundamentally inconsistent with the codebase\n- WARNING: Deviates from conventions in a notable way\n- SUGGESTION: Minor consistency improvement\n\nInclude file:line references for all issues."
  }
]
```

### Step 2: Synthesize findings

After all three agents complete, synthesize their findings:

1. **Verdict** — APPROVE / REQUEST CHANGES / BLOCK with a one-line summary
2. **Blockers** — all BLOCKER issues from all three reviewers (must fix)
3. **Warnings** — all WARNING issues (should fix)
4. **Suggestions** — all SUGGESTION items (nice to have)
5. **Positives** — what the code does well (always include at least one)
6. **Summary** — 2-3 sentences on the overall state of the review

## Output

Present the synthesized review grouped by severity (Blockers first, then Warnings, then Suggestions). Each item should have: reviewer source, file:line reference, and a clear description of the issue with suggested fix where applicable.
