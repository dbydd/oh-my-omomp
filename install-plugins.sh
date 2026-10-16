#!/usr/bin/env bash
set -euo pipefail

command -v omp >/dev/null 2>&1 || {
  printf '%s\n' 'omp is required on PATH' >&2
  exit 1
}

# Every plugin here points at OUR OWN fork. Nothing is installed from
# oh-my-omp/*: an install from upstream would overwrite our customizations.
#
# pi-hindsight is deliberately NOT installed here: it runs from the checkout at
# ~/manual_install_pkgs/pi-hindsight, symlinked into the plugin tree, so the
# fork's own development loop moves the live plugin. `omp install` replaces that
# symlink with a copied directory, which would freeze the plugin at install time.
plugins=(
  # dbydd/omp-todo-more: decider-gated stop reminders, subagent todo install,
  # executable init wording. Owned by us.
  'https://github.com/dbydd/omp-todo-more'
  # dbydd/omp-thinking-translator: fork of oh-my-omp/omp-thinking-translator.
  'https://github.com/dbydd/omp-thinking-translator'
  # npm plugin, no fork needed: no local customizations.
  'pi-intercom'
)

for plugin in "${plugins[@]}"; do
  omp install "$plugin"
done

# Every `omp install` re-links the whole plugin tree and replaces our pi-hindsight
# symlink with a copied directory. Re-link it afterwards so the fork's own
# development loop keeps moving the live plugin.
HINDSIGHT_SRC="$HOME/manual_install_pkgs/pi-hindsight"
HINDSIGHT_DST="$HOME/.omp/plugins/node_modules/@luxusai/pi-hindsight"
if [ -d "$HINDSIGHT_SRC" ]; then
  rm -rf "$HINDSIGHT_DST"
  ln -s "$HINDSIGHT_SRC" "$HINDSIGHT_DST"
  printf 'linked pi-hindsight -> %s\n' "$HINDSIGHT_SRC"
fi
