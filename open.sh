#!/bin/sh
set -eu
egress_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
egress_magpie=${MAGPIE_EXE:-$(command -v magpie || true)}
egress_cache="${XDG_CACHE_HOME:-$HOME/.cache}/magpie"
if [ -n "$egress_magpie" ]; then
  egress_paths=$("$egress_magpie" data)
  egress_config=$(printf '%s\n' "$egress_paths" | sed -n 's/^files: //p')
  egress_cache=$(printf '%s\n' "$egress_paths" | sed -n 's/^cache: //p')
  if [ -n "$egress_config" ]; then export ZCODE_EGRESS_MAGPIE_DIR="$egress_config"; fi
fi
egress_runtime=${MAGPIE_BUN:-}
for egress_candidate in "$egress_runtime" "$(command -v bun || true)" "$(command -v node || true)" "$egress_cache"/bun/*/magpie-bun "$egress_cache"/bun/musl/*/magpie-bun; do
  if [ -n "$egress_candidate" ] && [ -x "$egress_candidate" ] && "$egress_candidate" -e 'if (!process.versions.bun && Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' 2>/dev/null; then
    exec "$egress_candidate" "$egress_dir/manage.mjs" open "$@"
  fi
done
printf '%s\n' '未找到 Bun 或 Node.js 22+。请先运行 ./install.sh，并让 magpie 完成 Bun 下载。' >&2
exit 1
