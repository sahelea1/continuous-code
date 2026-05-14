---
description: Resume work from a previous handoff
subtask: true
---

You are running the /resume workflow. Your job is to read the latest session handoff, inject the prior session's context, and route to the appropriate specialist agent to continue the work.

## Context

Optional: specific handoff file or session to resume: $ARGUMENTS

## Pipeline

### Step 1: Find the handoff

If $ARGUMENTS specifies a handoff file path, use that directly.

Otherwise, find the most recent handoff:

```
Look in: thoughts/shared/handoffs/
Find the most recently modified .yaml file.
If the continuity ledger exists at thoughts/shared/CONTINUITY.md, read it to identify the latest session.
```

Read the handoff file fully before proceeding.

### Step 2: Inject context and orient

After reading the handoff, perform this orientation:

1. Report to the user what was found:
   - Session name and timestamp
   - Status (complete/partial/blocked)
   - Summary of what was accomplished
   - What is in-progress or blocked

2. Check git state against the handoff:
   - Is the branch the same?
   - Are there uncommitted changes that relate to the in-progress work?

3. Ask the user to confirm before proceeding (or proceed automatically if the next step is unambiguous).

### Step 3: Route to the appropriate specialist

Based on the handoff's `status` and `next_session` fields, route to the right agent:

**If status is `blocked`:**
Spawn a **sleuth** agent to investigate the blocker:
```
Investigate this blocker from the previous session:

[Handoff context]: {full handoff content}

Blocker: {blocker description from handoff}

Find the root cause and propose a resolution path.
```

**If status is `partial` and work is implementation:**
Spawn a **kraken** agent to continue:
```
Resume this in-progress implementation from the previous session:

[Handoff context]: {full handoff content}

In-progress task: {task from handoff}
State when left off: {state from handoff}
Next step: {next_step from handoff}

Continue from exactly where the previous session left off.
Run tests after each change to confirm nothing regressed.
```

**If status is `partial` and work is testing/verification:**
Spawn an **arbiter** agent:
```
Resume this in-progress verification from the previous session:

[Handoff context]: {full handoff content}

In-progress task: {task from handoff}
State when left off: {state from handoff}
Next step: {next_step from handoff}

Run the tests and report results.
```

**If status is `complete`:**
Report to the user that the previous session completed successfully and ask what to work on next. Suggest the `next_session.priority` from the handoff as the starting point.

**If the `suggested_command` field is set in the handoff:**
Follow that command's workflow with the handoff's context pre-loaded as background.

### Step 4: After resuming

Once the resumed work reaches a stopping point (complete, blocked again, or end of session), automatically trigger the /handoff workflow to capture the new state:

```
The resumed session has reached a stopping point.
Run the /handoff workflow to create a new handoff capturing what was accomplished.
```

## Output

Report:
- Which handoff was loaded
- What was in-progress or blocked
- Which agent was spawned to resume
- Outcome of the resumed work
