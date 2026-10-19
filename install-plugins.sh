#!/usr/bin/env bash
set -euo pipefail

command -v omp >/dev/null 2>&1 || {
  printf '%s\n' 'omp is required on PATH' >&2
  exit 1
}

plugins=(
  'https://github.com/mouriya-s-lab/pi-bansos'
  'https://github.com/oh-my-omp/omp-unified-exec'
  'https://github.com/oh-my-omp/omp-todo-more'
  'pi-commandcode-provider'
  'pi-package-search'
  'pi-pretty-codeblocks'
  'pi-schedule'
  'https://github.com/oh-my-omp/omp-thinking-translator'
  'https://github.com/oh-my-omp/omp-codex-image-gen'
  # 可选，默认不装：不是谁都需要远端构建环境，且依赖太多（omp-unified-exec、Mutagen、km CLI、Komodo Core/Periphery、可 SSH 的构建主机）。需要时加上引号取消注释。
  # https://github.com/oh-my-omp/omp-remote-build
  # 可选，默认不装：安装时要求 PATH 上有 Tern 的 `tern` 命令（Tern 桌面应用提供），没有 Tern 的机器会让整次 omp install 失败。装了 Tern 时加上引号取消注释。
  # https://github.com/oh-my-omp/omp-playbooks
)

for plugin in "${plugins[@]}"; do
  omp install "$plugin"
done
