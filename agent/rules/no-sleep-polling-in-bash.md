---
name: no-sleep-polling-in-bash
description: "Never use `sleep N` in a command to wait for progress — let omp background the long job and notify on completion"
condition: "\\bsleep\\s+\\d+"
scope: "tool"
---

A `sleep N` chained into a command to make time pass is manual polling and is forbidden.

- Long-running commands do not need watching: omp turns any non-pty call still running past ~60s into background job `bg_N`, keeps it running to its own deadline, and delivers the result back automatically as a follow-up message. Start the job, then do other work or end the reply and wait to be woken.
- To block on work already started, call `wait`. To inspect a running job, `read proc://<id>`; to stop it, `write proc://<id>/kill`. None of these needs a delay in front of them.
- `sleep` between two commands in one tool call is a wasted turn, and when a download is in flight it disturbs the very thing being measured — reconnects and stalls the transfer.
- If progress genuinely must be sampled (throughput over a window), make it a single bounded script that measures and reports once, then exits. Never `command; sleep N; command`.
- Report what the running job's own output or `proc://<id>` status already shows instead of re-sampling on a timer.