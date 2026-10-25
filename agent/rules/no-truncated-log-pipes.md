---
name: no-truncated-log-pipes
description: "Never truncate command logs with `2>&1 | tail` / `| head` — start a named job and read the full output through proc:// or PTC filtering"
condition: "2>&1\\s*\\|\\s*(tail|head)\\b|\\|\\s*(tail|head)\\s+-?\\d"
scope: "tool"
---

Do not append `2>&1 | tail -N` or any `| head -N` to a command to skim its log. That discards the evidence, hides the failing line, and gives you a partial picture you then have to re-run to fix.

Instead:
- Long-running or log-heavy command: run it with `bash` plus `name`, so it becomes a managed service. Read the whole log with `read proc://<name>` (or `proc://<name>:A-B` to page).
- One-off command whose output you need to filter: run it as an `eval` cell and filter in PTC mode — you already have the full result in hand, so `output(...)` with a query, or plain Python/JS list comprehension over the parsed result, keeps every line accessible.
- A command that must stay foreground but produces huge output: let omp spill it to `artifact://<id>` and read the ranges you need, rather than cutting the stream at the pipe.

Quieting a command (`-s`, `--quiet`, `-q`) is fine. Truncating a log is not.