---
description: Plan and build a feature end-to-end
subtask: true
---

You are running the /build workflow. Your job is to take a feature request through the full pipeline from planning to implementation, testing, and review.

## Context

Feature to build: $ARGUMENTS

## Pipeline

Execute the following pipeline in order:

### Step 1: Plan with plan-agent

Use the task tool to spawn a **plan-agent** agent:

```
Create a detailed implementation plan for this feature:

$ARGUMENTS

Your plan must include:
1. Feature breakdown into discrete, testable tasks
2. Files to create or modify (with rationale)
3. Interfaces and data structures needed
4. Dependencies or prerequisites
5. Testing strategy
6. Potential risks and mitigations

Output a numbered task list that implementation agents can execute sequentially.
```

### Step 2: Design with architect

Using the plan from Step 1, spawn an **architect** agent:

```
Review and enhance this implementation plan with architectural guidance:

[Feature]: $ARGUMENTS

[Plan from plan-agent]: {plan output}

Evaluate and document:
1. Architectural fit — does this match existing patterns?
2. Interface design — are the APIs clean and consistent?
3. Data flow — how does data move through the system?
4. Separation of concerns — are responsibilities well-defined?
5. Scalability considerations

Produce a design document with any plan amendments needed before implementation begins.
```

### Step 3: Implement with kraken

Using the plan and design from Steps 1-2, spawn a **kraken** agent:

```
Implement this feature following the plan and design:

[Feature]: $ARGUMENTS

[Implementation plan]: {plan output}

[Architectural design]: {architect output}

Requirements:
1. Implement tasks in the order specified by the plan
2. Write tests alongside each implementation task
3. Follow existing code patterns and architecture
4. Run tests after each task to catch issues early
5. Create a handoff note for each completed task

Report blockers immediately rather than proceeding with assumptions.
```

### Step 4: Test with arbiter

Spawn an **arbiter** agent to run the full test suite:

```
Verify the implementation of: $ARGUMENTS

[Implementation from kraken]: {kraken output}

Run:
1. Full test suite — all tests must pass
2. New tests added by kraken — verify adequate coverage
3. Type checks and linting
4. Integration tests if applicable

Report a detailed pass/fail summary with any failures explained.
```

### Step 5: Review with judge

Spawn a **judge** agent for code review:

```
Review the implementation of: $ARGUMENTS

[Implementation from kraken]: {kraken output}
[Test results from arbiter]: {arbiter output}

Evaluate:
1. Code quality and adherence to project patterns
2. Test completeness and quality
3. Security considerations
4. Performance implications
5. Documentation and code clarity

Flag any issues as: BLOCKER / WARNING / SUGGESTION
```

### Step 6: Create handoff with scribe

Spawn a **scribe** agent:

```
Create a session handoff for the completed feature build:

[Feature]: $ARGUMENTS

Include:
- Plan summary from plan-agent
- Design decisions from architect
- Implementation summary from kraken (files changed)
- Test results from arbiter
- Review findings from judge
- Status: complete/partial/blocked
- Any follow-up items

Write to: thoughts/shared/handoffs/<session-slug>/<timestamp>.yaml

Update the continuity ledger at thoughts/shared/CONTINUITY.md if it exists.
```

## Output

After all steps complete, summarize:
- Feature built
- Key design decisions made
- Files created or modified
- Test coverage
- Any review issues flagged (and whether addressed)
- Handoff location
