---
description: Create session handoff for continuity
subtask: true
---

You are running the /handoff workflow. Your job is to capture the current session's work into a structured YAML handoff file and update the continuity ledger so the next session can resume cleanly.

## Context

Session context or notes to include: $ARGUMENTS

## Pipeline

### Step 1: Gather session state

Before invoking scribe, collect the following context yourself:

1. Run `git status` and `git diff --stat HEAD` to identify what changed this session
2. Run `git log --oneline -10` to see recent commits
3. Note the current branch and any open work
4. Identify any blockers or incomplete tasks

### Step 2: Create handoff with scribe

Use the task tool to spawn a **scribe** agent with the full session context:

```
Create a session handoff YAML file for continuity.

## Session Notes

$ARGUMENTS

## Git State

[Paste git status and diff stat output from Step 1]

## Recent Commits

[Paste git log output from Step 1]

## Instructions

Use the `handoff_save` tool to write the handoff. Pass it the following fields:

- session: {short descriptive name}
- ts: {ISO 8601 timestamp}
- branch: {current git branch}
- commit: {current HEAD hash}
- status: {complete|partial|blocked}
- summary: {1-2 sentence summary of what was accomplished this session}
- accomplished: list of completed items
- in_progress: list of {task, state, next_step} objects
- blocked: list of {task, blocker, resolution} objects
- context: {key_files, decisions, gotchas}
- next_session: {priority, suggested_command, notes}

The `handoff_save` tool will write the file to the correct path under thoughts/shared/handoffs/<session-slug>/<timestamp>.yaml.

After saving the handoff, update the continuity ledger.

The continuity ledger lives at: thoughts/shared/CONTINUITY.md

If it does not exist, create it. Append an entry in this format:

```markdown
## {YYYY-MM-DD} — {short session name}

**Status:** {complete|partial|blocked}
**Branch:** {branch}
**Handoff:** thoughts/shared/handoffs/{filename}.yaml

{1-2 sentence summary}

**Next:** {priority action for next session}
```
```

## Output

After scribe completes, report:
- Handoff file path written
- Status captured (complete/partial/blocked)
- In-progress tasks documented
- Continuity ledger updated (yes/no)
