---
description: Test-driven development workflow
subtask: true
---

You are running the /tdd workflow. This is a strict test-first pipeline: plan test cases, write failing tests, implement minimal code to pass, then verify everything is green.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

## Context

Feature or behavior to implement with TDD: $ARGUMENTS

## Pipeline

Execute the following pipeline in order:

### Step 1: Plan with plan-agent

Use the task tool to spawn a **plan-agent** agent:

```
Create a TDD test plan for: $ARGUMENTS

Design the test cases ONLY — do not write any implementation code.

For each behavior to test, specify:
1. Test name (describes the behavior clearly)
2. Input / precondition
3. Expected output / postcondition
4. Edge cases to cover

Order the tests from simplest to most complex. The implementation agent will use this plan to write tests one at a time in RED-GREEN-REFACTOR cycles.

Output: An ordered list of test specifications.
```

### Step 2: Write failing tests with arbiter (RED phase)

Using the test plan from Step 1, spawn an **arbiter** agent:

```
Write failing tests for: $ARGUMENTS

[Test plan from plan-agent]: {plan output}

Rules:
1. Write tests ONLY — zero production/implementation code
2. Run each test after writing it to confirm it FAILS
3. If a test passes immediately, it is testing existing behavior — flag this
4. Tests must fail because the feature is missing, not due to syntax errors
5. Use clear test names that describe the expected behavior

After writing all tests, run the full test suite and report which tests are failing and why (expected failures).
```

### Step 3: Implement with kraken (GREEN phase)

Using the failing tests from Step 2, spawn a **kraken** agent:

```
Implement minimal code to pass the failing tests for: $ARGUMENTS

[Failing tests from arbiter]: {arbiter output}

Rules:
1. Write ONLY enough code to make the failing tests pass
2. Do not add features, optimizations, or "improvements" not required by the tests
3. Run tests after each small change
4. Once tests pass, stop adding code
5. Then do a REFACTOR pass: clean up names, remove duplication, extract helpers — while keeping all tests green

Report: which tests now pass, and the final state of the test suite.
```

### Step 4: Verify with arbiter (final check)

Spawn a final **arbiter** agent to confirm the full suite is clean:

```
Final TDD verification for: $ARGUMENTS

[Implementation from kraken]: {kraken output}

Confirm:
1. All new tests written in Step 2 are passing
2. No pre-existing tests were broken
3. Test output is clean (no errors, no warnings)
4. Run any type checks or linting on the changed files

Report: PASS or FAIL with full test output summary.
```

## Output

After all steps complete, summarize:
- Feature implemented
- Number of tests written
- All tests passing (yes/no)
- Files modified
- Any refactoring done in the GREEN phase
