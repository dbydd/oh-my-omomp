---
name: tern-session-required
description: Every `tern` CLI call must name its session; a call that omits it can reach another session's terminal.
condition:
  - 'tern\s+(send|capture|run|close|kill|process|wait|split|pip|dock|rename|focus|inspect|move|keep-open)\b'
scope:
  - tool:bash
  - tool:bash_bg
question: >-
  This call runs the Tern terminal multiplexer. Tern hosts many sessions at once and a call
  without a session reaches whichever one the daemon defaults to, which may be another
  person's or another agent's terminal — writing input into their shell, capturing their
  screen, or closing their block. Answer yes only if the call names its session explicitly:
  the block argument appears as `SESSION/BLOCK`, or a session id was resolved and passed in.
  Answer no if the call passes a bare block id, `@focused`, a title, or a program name with no
  session, or if no SESSION/BLOCK form and no `--window`-independent session is present.
interruptMode: tool-only
---

Use the `tern` tool for Tern, not hand-written `tern` commands in `bash`. Its `session` argument is required, its block is always `SESSION/BLOCK`, and every op that changes the screen dumps one page of output when it finishes. The bash forms below are for when the tool is unavailable.

Tern multiplexes terminals: one machine runs several sessions, each with several tabs and blocks. **Every `tern` call must name its session.**

Write the target as `SESSION/BLOCK`, for example `tern capture onlyne:alexandria/32057635897346`. `--window KEY` selects a window and does not select a session, so it is not enough.

**If you do not know which session you are in, ask the human; do not guess.** `tern whoami` reports the identity chain of the pane the process runs in. If the process is not inside a Tern pane, `tern ls` only tells you which sessions the machine has — it does **not** tell you which one is yours, and that is exactly the case that requires asking. Guessing wrong writes into someone else's terminal.

Driving an interactive program takes these four steps, in order:

1. Start it: `tern new tab <session> --keep-open --json -- <command>`, and take the block id from the JSON. `--keep-open` is required — otherwise the block disappears the moment the program exits.
2. Write to it: `tern send <session>/<block> text "<input>"` pastes characters, then `tern send <session>/<block> keys enter` presses Enter. Control keys are written `ctrl+c`, `ctrl+d`, `esc`.
3. Read it: `tern capture <session>/<block> --ansi` for the current screen, `--scrollback` to include history. Do not move on until the screen really shows what you expect.
4. Finish: let the program exit on its own, `tern wait <session>/<block> --until exit --timeout N` for the exit status, then `tern close <session>/<block>`.

Before you finish, run `tern ls` to check that you left no block open.
