---
description: Switch this conversation into workflow mode for a task
subtask: false
---

Switch this conversation into workflow mode for: $ARGUMENTS

Scope the work inline, design a phase DAG, then call the **ultracode** tool with the resulting `WorkflowSpec`.

## How to proceed

1. **Restate the goal** in one sentence to confirm understanding.
2. **Scope inline** — identify the natural phases (gather, design, implement, verify, document) and which are independent vs. dependent.
3. **Design the DAG**:
   - Independent phases → parallel nodes in the same WorkflowSpec phase.
   - Dependent phases → sequential pipeline stages.
4. **Assign per node**: `agentType`, model class (opus for logic/implement/verify; sonnet for read/gather/docs), and `effort`.
5. **Call `ultracode`** with the complete spec. Do not hand-roll multi-step work via individual task calls when a workflow fits.
6. **Report** the synthesized result once the workflow completes.

## Node selection guide

| Work type | agentType | Model |
|---|---|---|
| Explore / read / gather | scout | sonnet-class |
| External research | oracle | sonnet-class |
| Architecture / design | architect | opus-class |
| Implement / TDD | kraken | opus-class |
| Quick patch | spark | sonnet-class |
| Test / verify | arbiter | opus-class |
| Review / quality | judge | opus-class |
| Debug / root cause | sleuth | opus-class |
| Docs / handoff | scribe | sonnet-class |

## DAG patterns

**Parallel** — use when items are independent:
```
[scout A] ──┐
[scout B] ──┼──► [kraken: implement]
[oracle]  ──┘
```

**Pipeline** — use when each stage gates the next:
```
[kraken: implement] ──► [arbiter: verify] ──► [judge: review]
```

**Mixed** — most real tasks:
```
[scout + oracle parallel] ──► [architect: design] ──► [kraken + arbiter parallel]
```

Express the full DAG as a single `WorkflowSpec` and call `ultracode` now.
