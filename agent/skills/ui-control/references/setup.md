# Complete setup

This setup makes the `ui-control` skill's window-safety workflow available on a Mac. The skill arrives through the repository copy set; the remaining machine steps enable OmniWM IPC and verify the focus-guard cycle.

## Prerequisites

- macOS with OmniWM installed in `/Applications/OmniWM.app`
- OmniWM 0.5.9 or a later version that supports the documented CLI commands
- omp with `~/.omp/agent/skills/ui-control/` installed from the repository copy set
- `jq` and `bash`

Keep the app and its bundled `omniwmctl` together. The IPC protocol is version-coupled; do not substitute an older standalone CLI.

## Install

1. Copy the repository's `agent/skills/ui-control/` directory into `~/.omp/agent/skills/`.
2. Set `general.ipcEnabled = true` in `~/.config/omniwm/settings.toml`, then restart OmniWM if live reload did not enable IPC.

Skill discovery picks the new skill up on the next omp session. Sessions that were already running may have loaded the old skill list.

## Verify

Focus an OmniWM-managed window, then run:

```bash
~/.omp/agent/skills/ui-control/scripts/verify-setup.sh
```

The verifier checks:

- the installed `ui-control` skill and its `focus-guard.sh`;
- the bundled CLI, live IPC ping, and protocol version;
- `jq` support;
- a real `capture`, `status`, and `restore` cycle without moving or resizing a window.

Set `AGENT_SKILLS_ROOT` to verify a non-default agent root, and `OMNIWMCTL` to verify a non-bundled CLI.

For an explicit guard test, use a short TTL:

```bash
guard_json=$(~/.omp/agent/skills/ui-control/scripts/focus-guard.sh guard --ttl 5)
guard_token=$(jq -r '.token' <<<"$guard_json")
~/.omp/agent/skills/ui-control/scripts/focus-guard.sh status "$guard_token"
~/.omp/agent/skills/ui-control/scripts/focus-guard.sh restore "$guard_token"
```

## How agents should use it

- Prefer headless, in-app, or non-activating automation.
- Guard one background-capable tool call, then restore immediately.
- Capture immediately before one foreground-only action, then restore immediately.
- Re-capture before later actions so the user's current choice is respected.
- Diff window IDs before and after launches. Contain only fresh agent-created windows.
- Never move, resize, scratchpad, close, or reassign a pre-existing user window for automation convenience.

The guard responds to OmniWM focus events and retains polling as a fallback. Its TTL prevents an abandoned guard from indefinitely fighting user input.

## Troubleshooting

If `omniwmctl ping` reports connection refused:

1. Confirm OmniWM is running.
2. Confirm `[general]` contains `ipcEnabled = true`.
3. Confirm the bundled CLI is executable.
4. Restart OmniWM if live reload did not enable IPC.

If capture reports no focused managed window, focus a normal OmniWM-managed app window and retry. OmniWM does not return unmanaged windows through `query focused-window`.

## Roll back

Remove the installed skill directory:

```bash
rm -Ri ~/.omp/agent/skills/ui-control
```

IPC may be disabled manually by setting `general.ipcEnabled = false`, but the focus guard cannot operate while IPC is disabled.

## Limitation

Focus restoration cannot guarantee that a newly created macOS window is never rendered for a frame. Headless or explicitly non-activating automation gives the strongest protection. Use a separately identifiable automation app/profile or a dedicated OmniWM workspace when new windows must remain open; do not apply broad rules to a user's existing Chrome windows.
