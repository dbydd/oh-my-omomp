#!/usr/bin/env bash
set -euo pipefail

command -v omp >/dev/null 2>&1 || {
  printf '%s\n' 'omp is required on PATH' >&2
  exit 1
}

# Every plugin here points at OUR OWN fork. Nothing is installed from
# oh-my-omp/*: an install from upstream would overwrite our customizations.
#
# pi-hindsight is installed here rather than symlinked to a checkout, so the
# machine runs a published release instead of whatever the checkout holds. Its code
# reaches omp's own packages through `@oh-my-pi/*`; a checkout that is being
# edited can make that ladder silently unavailable (the failure appears as an
# unrunnable judgment/role rung, with no error). Re-run this script after
# publishing a new version.
plugins=(
  # dbydd/omp-todo-more: decider-gated stop reminders, subagent todo install,
  # executable init wording. Owned by us.
  'https://github.com/dbydd/omp-todo-more'
  # dbydd/omp-thinking-translator: fork of oh-my-omp/omp-thinking-translator.
  'https://github.com/dbydd/omp-thinking-translator'
  # dbydd/pi-hindsight-s1enhanced: our package, published to npm. @luxusai's
  # line stopped updating and nothing here installs from it.
  '@dbydd/pi-hindsight-s1enhanced'
  # dbydd/onlyne: Onlyne v3's OMP integration, linked from its working checkout
  # instead of installed from npm, so the machine runs the code being developed
  # there. `bun run devinstall` in that checkout performs the same link.
  '/Users/dbydd/Documents/progs/onlyne/packages/omp-onlyne'
)

for plugin in "${plugins[@]}"; do
  omp install "$plugin"
done
