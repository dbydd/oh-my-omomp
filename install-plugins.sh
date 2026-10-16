#!/usr/bin/env bash
set -euo pipefail

command -v omp >/dev/null 2>&1 || {
  printf '%s\n' 'omp is required on PATH' >&2
  exit 1
}

# Every plugin here points at OUR OWN fork. Nothing is installed from
# oh-my-omp/*: an install from upstream would overwrite our customizations.
#
# pi-hindsight MUST be installed as a copy inside the plugin tree, never
# symlinked to a dev checkout. Its code reaches omp's own packages through
# @oh-my-pi/*, and node resolution only finds them by ascending into
# ~/.omp/plugins/node_modules — which a copied package does and a symlink to a
# checkout outside the tree does not, so a symlinked plugin silently loses its
# judgment/role ladder. Re-run this script after a hindsight merge.
plugins=(
  # dbydd/omp-todo-more: decider-gated stop reminders, subagent todo install,
  # executable init wording. Owned by us.
  'https://github.com/dbydd/omp-todo-more'
  # dbydd/omp-thinking-translator: fork of oh-my-omp/omp-thinking-translator.
  'https://github.com/dbydd/omp-thinking-translator'
  # dbydd/pi-hindsight: our fork, and the only upstream now.
  'https://github.com/dbydd/pi-hindsight'
  # npm plugin, no fork needed: no local customizations.
  'pi-intercom'
)

for plugin in "${plugins[@]}"; do
  omp install "$plugin"
done
