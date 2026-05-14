---
description: Explore codebase from multiple angles in parallel
subtask: true
---

You are running the /explore workflow. This spawns multiple specialist agents in parallel to explore the codebase from different angles, then synthesizes their findings.

## Context

What to explore: $ARGUMENTS

If $ARGUMENTS is empty, do a general codebase orientation.

## Pipeline

### Step 1: Parallel exploration

Call `parallel_delegate` with the following array of `{agent, prompt}` pairs to spawn all four agents simultaneously:

```json
[
  {
    "agent": "scout",
    "prompt": "Explore the structure of this codebase.\n\nFocus: $ARGUMENTS (or general structure if not specified)\n\nUse tldr and file reading to map:\n1. File tree and directory organization\n2. Entry points (main, cli, app, index files)\n3. Key modules and their responsibilities\n4. How the codebase is organized (layers, features, domains)\n\nOutput a structured summary with file:line references for key components."
  },
  {
    "agent": "scout",
    "prompt": "Explore the coding patterns and conventions in this codebase.\n\nFocus: $ARGUMENTS (or general patterns if not specified)\n\nInvestigate:\n1. Design patterns in use (repository, service, factory, etc.)\n2. Error handling approach\n3. Testing conventions and test organization\n4. Data flow patterns (how data moves through the system)\n5. Configuration and environment handling\n\nOutput a patterns summary with concrete examples from the code."
  },
  {
    "agent": "scout",
    "prompt": "Explore the dependencies and integration points in this codebase.\n\nFocus: $ARGUMENTS (or general dependencies if not specified)\n\nMap:\n1. External libraries and frameworks (and why they're used)\n2. Internal module dependencies (what imports what)\n3. Integration points with external services or APIs\n4. Any circular dependencies or coupling concerns\n5. Build and tooling setup\n\nOutput a dependency map with notes on key relationships."
  },
  {
    "agent": "oracle",
    "prompt": "Research external context relevant to: $ARGUMENTS\n\nBased on the technology stack and patterns in this codebase, find:\n1. Best practices and common conventions for the stack\n2. Known pitfalls or gotchas to watch out for\n3. Relevant documentation or reference material\n4. How peers typically structure similar codebases\n\nOutput actionable insights that would help someone working in this codebase."
  }
]
```

### Step 2: Synthesize findings

After all four agents complete, synthesize their outputs into a unified exploration report:

1. **Orientation summary** — what this codebase is and how it's organized (from Agent A)
2. **Patterns and conventions** — how code is written here (from Agent B)
3. **Dependencies and integrations** — what it depends on and connects to (from Agent C)
4. **External context** — best practices and pitfalls (from Agent D)
5. **Key insights** — the 3-5 most important things to know before working in this codebase
6. **Recommended entry points** — where to start reading if you want to understand a specific area

## Output

Present the synthesized report in a clear, skimmable format. Use concrete file:line references throughout. End with a "where to go next" recommendation based on what was found.
