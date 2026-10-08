#!/bin/bash
# 一条命令：方案仓库 → 网站仓库里的四个镜像（web/data/base.img + 每个方案一个）
#
#   bash tools/wasm-build/build-all.sh                  # 全量：更新仓库 → 部署 → 打四个镜像
#   bash tools/wasm-build/build-all.sh --only 27c       # 只重打 27c 的方案镜像
#   bash tools/wasm-build/build-all.sh --no-update      # 不 clone / 不 fetch，用现有 checkout
#   bash tools/wasm-build/build-all.sh --rebuild-librime
#
# 具体做了什么（设计见同目录 README.md）：
#   1) 把三个方案仓库（含 engine/ 子模块）和 flow_engine clone / 快进到最新；
#   2) rime.js + rime.wasm 已有就跳过 librime 编译（--rebuild-librime 才重编）；
#   3) export-data.sh：三个方案摊进同一个 rime 用户目录 → rime_deployer 部署一次 →
#      拆成 base.img / <方案>.img → 写进 web/data/（顺带重写 layouts.js、sizes.js）。
#
# 依赖：git、python3（含 lzma）、rime_deployer（Debian/Ubuntu 的 librime-bin）、
#       /usr/share/rime-data；只有要重编 wasm 时才需要 emcc（emsdk）。
set -euo pipefail

# cd -P：允许从旧路径 tools/wasm-build（symlink）跑，不然 ../.. 会算错
SELF=$(cd -P "$(dirname "$0")" && pwd -P)
WEB=$(cd "$SELF/../.." && pwd)          # 网站仓库根 = 站点根，web/data/*.img 的落点

SCHEME_REPOS=(
  "rime_jd27c_flow|https://github.com/xkjd27/rime_jd27c_flow"
  "rime_jd27_flow|https://github.com/xkjd27/rime_jd27_flow"
  "rime_keytao_flow|https://github.com/xkjd27/rime_keytao_flow"
)
ENGINE_NAME=flow_engine
ENGINE_URL=https://github.com/xkjd27/flow_engine

ONLY=()
UPDATE=1
REBUILD_LIBRIME=0
SKIP_LIBRIME=0
WORK_ARG=

usage() {
  cat <<'EOF'
用法：bash tools/wasm-build/build-all.sh [选项] [方案...]

  方案：27c / 27 / keytao（不给 = 三个都打；也可以写成 --only 27c）

选项：
  --work DIR         方案仓库、flow_engine、中间产物放哪（默认见 README「路径」）
  --only K [K...]    只重打这些方案的镜像（base.img 照样重打，内容与全量一致）
  --no-update        不 clone / 不 fetch，直接用现有 checkout（离线也能跑）
  --rebuild-librime  强制重编 web/rime.js + web/rime.wasm（默认：已存在就跳过）
  --no-librime       完全跳过 wasm 检查
  -h, --help         这段

环境变量：XKJD_WORK（= --work）、XKJD_WASM_ROOT（librime 源码与编译缓存，默认见 README）。
EOF
}

die() { echo -e "✗ $*" >&2; exit 1; }
say() { printf '\n===== %s =====\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --work)     [ $# -ge 2 ] || die "--work 缺参数"; WORK_ARG=$2; shift 2 ;;
    --work=*)   WORK_ARG=${1#--work=}; shift ;;
    --only)     shift; while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do ONLY+=("$1"); shift; done ;;
    --no-update) UPDATE=0; shift ;;
    --rebuild-librime) REBUILD_LIBRIME=1; shift ;;
    --no-librime) SKIP_LIBRIME=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    -*)         die "不认识的选项：$1（-h 看用法）" ;;
    *)          ONLY+=("$1"); shift ;;
  esac
done

# ---- 工作目录：--work > $XKJD_WORK > 「网站仓库的上一级（那里已经有方案仓库就用它）」
#      > $XDG_CACHE_HOME/xkjd27（干净机器上从零 clone 到这里）
if [ -n "$WORK_ARG" ]; then WORK=$WORK_ARG
elif [ -n "${XKJD_WORK:-}" ]; then WORK=$XKJD_WORK
elif [ -d "$(dirname "$WEB")/rime_jd27c_flow/rime" ] && [ -d "$(dirname "$WEB")/rime_keytao_flow/rime" ]; then
  WORK=$(dirname "$WEB")
else WORK=${XDG_CACHE_HOME:-$HOME/.cache}/xkjd27
fi
mkdir -p "$WORK" || die "建不了工作目录：$WORK"
WORK=$(cd "$WORK" && pwd)

# ---- librime 源码/编译缓存：默认放工作目录里（别放 /tmp：本机 /etc/tmpfiles.d/tmp.conf
#      会把 1 天没碰过的文件清掉，boost / lua 解包出来的源码 mtime 是旧的，会被删光）
WASM_ROOT=${XKJD_WASM_ROOT:-$WORK/wasm}

echo "网站仓库   $WEB"
echo "工作目录   $WORK"
echo "wasm 缓存  $WASM_ROOT"
case "$WASM_ROOT" in
  /tmp/*|/var/tmp/*)
    echo "  ! 缓存放在 /tmp 下：本机 /etc/tmpfiles.d/tmp.conf 会把 1 天没碰过的文件清掉"
    echo "    （boost/lua 解包出来的源码 mtime 是旧的，会被删 —— 本机旧缓存 /tmp/rime_wasm 就这样烂的）"
    echo "    建议换到持久目录：XKJD_WASM_ROOT=$WORK/wasm" ;;
esac

# ---- 依赖检查（现在只查 export 那半，emcc 等真要编译时再查）
have git || die "没有 git"
have python3 || die "没有 python3"
python3 -c 'import lzma' 2>/dev/null || die "python3 缺 lzma 模块（Debian/Ubuntu：apt install python3 自带；自编的 python 要 --with-lzma）"
have rime_deployer || die "没有 rime_deployer（Debian/Ubuntu：apt install librime-bin；Arch：librime）"
[ -f "${XKJD_SHARED:-/usr/share/rime-data}/default.yaml" ] || \
  die "没有 librime 共享数据 ${XKJD_SHARED:-/usr/share/rime-data}/default.yaml（装 librime-data / 或给 XKJD_SHARED）"

# ---------------------------------------------------------------- 1) 仓库
say "方案仓库"
ensure_repo() {  # name url
  local name=$1 url=$2 dir=$WORK/$1
  if [ -d "$dir/.git" ]; then
    if [ "$UPDATE" = 0 ]; then
      echo "  = $name（--no-update，用现有 $(git -C "$dir" rev-parse --short HEAD)）"
      return 0
    fi
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
      echo "  ! $name 有未提交改动，跳过更新（你的改动不会被冲掉）"
      return 0
    fi
    if git -C "$dir" fetch --quiet origin 2>/dev/null &&
       git -C "$dir" merge --quiet --ff-only FETCH_HEAD 2>/dev/null; then
      echo "  ↑ $name → $(git -C "$dir" rev-parse --short HEAD)"
    else
      echo "  ! $name 拉取/快进失败（离线？还是本地分叉了？）—— 用现有 $(git -C "$dir" rev-parse --short HEAD)"
    fi
    git -C "$dir" submodule update --init --recursive --quiet 2>/dev/null ||
      echo "  ! $name 的 engine/ 子模块没更新（打镜像不用它，先从 $ENGINE_NAME 拿 lua 引擎）"
  else
    echo "  + clone $name"
    git clone --quiet --recurse-submodules "$url" "$dir" ||
      die "clone $name 失败（网络？仓库地址？）"
  fi
}

for entry in "${SCHEME_REPOS[@]}"; do
  ensure_repo "${entry%%|*}" "${entry#*|}"
done
ensure_repo "$ENGINE_NAME" "$ENGINE_URL"

[ -f "$WORK/$ENGINE_NAME/lua/flow_codes.lua" ] ||
  die "找不到 lua 引擎 $WORK/$ENGINE_NAME/lua（flow_engine 没 clone 好？）"

# ---------------------------------------------------------------- 2) librime wasm
say "librime wasm"
if [ "$SKIP_LIBRIME" = 1 ]; then
  echo "  跳过（--no-librime）"
elif [ -f "$WEB/rime.js" ] && [ -f "$WEB/rime.wasm" ] && [ "$REBUILD_LIBRIME" = 0 ]; then
  echo "  ✓ 已有 rime.js + rime.wasm，跳过编译"
  if [ "$SELF/api.cpp" -nt "$WEB/rime.wasm" ] || [ "$SELF/lzma/Lzma2Dec.c" -nt "$WEB/rime.wasm" ]; then
    echo "  ! api.cpp / lzma 比 rime.wasm 新：改了 C API 就得 --rebuild-librime，不然网页还是旧的"
  fi
else
  if ! have emcc; then
    for c in "${XKJD_EMSDK:-}" "$HOME/emsdk" /opt/emsdk /usr/lib/emsdk; do
      if [ -n "$c" ] && [ -f "$c/emsdk_env.sh" ]; then
        echo "  source $c/emsdk_env.sh"
        set +u; . "$c/emsdk_env.sh" >/dev/null 2>&1 || true; set -u
        break
      fi
    done
  fi
  have emcc || die "没有 emcc：装 emsdk（https://emscripten.org）后 source emsdk_env.sh，或用 XKJD_EMSDK 指到 emsdk 目录"
  ROOT=$WASM_ROOT OUT=$WEB bash "$SELF/build-librime.sh"
fi

# ---------------------------------------------------------------- 3) 部署 + 打镜像
say "部署 + 打镜像"
if [ ${#ONLY[@]} -gt 0 ]; then
  XKJD_WORK=$WORK bash "$SELF/export-data.sh" "${ONLY[@]}"
else
  XKJD_WORK=$WORK bash "$SELF/export-data.sh"
fi

# ---------------------------------------------------------------- 4) 结果
say "产物"
ls -la "$WEB/data"/*.img | awk '{printf "  %9.2f KB  %s\n", $5/1024, $9}'
echo
md5sum "$WEB/data"/*.img
echo
echo "别忘了起个静态服务看一眼主页（window.__ready === true 且三个方案都能出候选）"
