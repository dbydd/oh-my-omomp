---
name: no-sliced-agent-logs
description: "Never page or slice an agent transcript or chat log with head/tail/less/more/sed -n or a range selector — filter the whole chain with PTC instead"
condition: ["(?=[\\s\\S]*(?:\\.jsonl|history://|/sessions/))(?=[\\s\\S]*(?:\\bhead\\b|\\btail\\b|\\bless\\b|\\bmore\\b|\\bsed\\s+-n\\b))", "(?=[\\s\\S]*(?:\\.jsonl|history://|/sessions/))(?=[\\s\\S]*:(?:raw:)?-?\\d)"]
scope: ["tool:bash", "tool:read"]
---

An agent-class log — a session transcript, a chat record, an agent's history — is an append-only conversation, not a program artifact. A slice of it is never reliable evidence: the record that explains the symptom sits far from the symptom, and paging skills tuned for build output (`head`, `tail`, `sed -n`, `-n` line limits) show you a fragment while hiding the cause. Reading four-fifths of a decision's context and concluding from it is how a confident wrong claim gets made.

Never page one. No `head`, `tail`, `less`, `more`, `sed -n`, `grep -c … | head`, and no range or tail selector (`:-120`, `:raw:50-80`, `:1-50`) on a `history://`, `*.jsonl`, or `sessions/` path.

Read the whole chain with PTC instead: `eval` a filter that loads the file, keeps the records you actually need — by `role`, `type`, `timestamp`, or a substring — and prints them with their entry ids. Filter by field in code, never by line position. That reads the entire chain and hands you an auditable subset.

State the filter you used and what it kept or dropped, so the reader can tell what the result does and does not cover. A 14 MB transcript is proof of the same point: opening it whole is impractical, so filter it in code rather than reaching for a page window.