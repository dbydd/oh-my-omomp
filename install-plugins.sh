#!/usr/bin/env bash
set -euo pipefail

command -v omp >/dev/null 2>&1 || {
  printf '%s\n' 'omp is required on PATH' >&2
  exit 1
}

plugins=(
  'https://github.com/oh-my-omp/omp-unified-exec'
  'https://github.com/oh-my-omp/omp-todo-more'
  'https://github.com/oh-my-omp/omp-thinking-translator'
  'pi-intercom'
  'https://github.com/dbydd/pi-hindsight'
)

for plugin in "${plugins[@]}"; do
  omp install "$plugin"
done
