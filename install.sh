#!/bin/sh
set -eu
egress_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
egress_magpie=${MAGPIE_EXE:-$(command -v magpie || true)}
if [ -z "$egress_magpie" ]; then
  printf '%s\n' '找不到 magpie。请设置 MAGPIE_EXE 为 magpie 的完整路径，再运行此脚本。' >&2
  exit 1
fi
"$egress_magpie" plugin add "$egress_dir"
"$egress_magpie" plugin on "$egress_dir"
printf '%s\n' '已注册并启用。请保留此目录；入口位于 magpie 导航的「插件 → 出口管家」。'
MAGPIE_EXE="$egress_magpie" "$egress_dir/open.sh" "$@"
