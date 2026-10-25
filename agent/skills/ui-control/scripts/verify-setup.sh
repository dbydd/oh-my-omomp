#!/usr/bin/env bash
set -euo pipefail

command -v jq >/dev/null 2>&1 || {
  printf '%s\n' 'FAIL: jq is required.' >&2
  exit 69
}

agent_root=${AGENT_SKILLS_ROOT:-"$HOME/.omp/agent"}
skill_dir="$agent_root/skills/ui-control"
guard="$skill_dir/scripts/focus-guard.sh"
ctl=${OMNIWMCTL:-/Applications/OmniWM.app/Contents/MacOS/omniwmctl}

[[ -f "$skill_dir/SKILL.md" ]] || {
  printf 'FAIL: installed ui-control skill not found at %s\n' "$skill_dir" >&2
  exit 2
}
[[ -x "$guard" ]] || {
  printf 'FAIL: installed focus guard is missing or not executable: %s\n' "$guard" >&2
  exit 2
}
[[ -x "$ctl" ]] || {
  printf 'FAIL: bundled omniwmctl not found at %s\n' "$ctl" >&2
  exit 69
}
printf 'PASS: ui-control is installed at %s\n' "$skill_dir"

"$ctl" ping >/dev/null || {
  printf '%s\n' \
    'FAIL: OmniWM IPC is not reachable; check that OmniWM runs and general.ipcEnabled is true in ~/.config/omniwm/settings.toml.' >&2
  exit 2
}
version=$("$ctl" version)
printf 'PASS: OmniWM IPC is live: %s\n' "$version"

focus_token=''
cleanup() {
  if [[ -n "$focus_token" ]]; then
    "$guard" restore "$focus_token" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

capture_json=$("$guard" capture)
focus_token=$(jq -r '.token' <<<"$capture_json")
[[ -n "$focus_token" && "$focus_token" != null ]] || {
  printf '%s\n' 'FAIL: focus capture did not return a token.' >&2
  exit 2
}
status_json=$("$guard" status "$focus_token")
jq -e '.ok == true and .mode == "capture" and .active == false' \
  <<<"$status_json" >/dev/null
restore_json=$("$guard" restore "$focus_token")
focus_token=''
jq -e '.ok == true and .restored == true' <<<"$restore_json" >/dev/null

printf '%s\n' 'PASS: focus capture, status, and restoration succeeded.'
printf '%s\n' 'ui-control setup verified.'
