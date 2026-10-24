---
name: context-file-sync-direction
description: "Context files sync by mtime alone: the newer side wins. Extensions and plugins are excluded and merged case by case"
condition: "(?=[\\s\\S]*\\.omp/agent)(?=[\\s\\S]*(AGENTS|RULES|PERSONALITY|APPEND_SYSTEM)\\.md)"
scope: "tool"
---

When a context file exists both in this repository (`agent/AGENTS.md`, `agent/RULES.md`, `agent/PERSONALITY.md`, and `agent/rules/*.md`) and on the machine (`~/.omp/agent/…`), the direction of a sync is decided by modification time alone.

- Machine copy newer → copy the machine copy over the repository copy.
- Repository copy newer → copy the repository copy over the machine copy.
- Compare `stat` output before touching either side, and say in the reply which side won and why.
- Do not merge the two texts, do not treat the repository as the source of truth by default, and do not decide from a content diff. A file the two sides disagree on is not a conflict to reconcile; it is an older copy to be replaced.

This rule covers context files only — the files OMP injects as prompt text. It does not cover extensions (`agent/extensions/`, `agent/extensions-last/`) or plugins: those are merged change by change, by reading what each side actually does.
