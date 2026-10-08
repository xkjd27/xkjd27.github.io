#!/bin/bash
# 把「方案文件 + 预编译词库产物」部署一次，拆成网站仓库 web/data/ 下的四个压缩镜像：
#
#   web/data/base.img     公共镜像：共享数据 + lua 引擎 + 配置（几十 KB，进页面就挂）
#   web/data/<方案>.img   每个方案一份：方案文件 + 词库产物（27c / 27 约 7 MB，keytao 约 1.1 MB）
#
# 顺带重写 web/data/layouts.js（键位表）与 web/data/sizes.js（镜像体积）。
# 三个方案装进**同一个 rime 用户目录**（跟真实用户把三个方案都装上一样），
# 一份 lua 引擎、一份共享数据、各自的方案与词库产物，部署一次拿全部产物，再按
# 「公共 / 每个方案」拆开（文件名互不重叠，先后挂进同一个内存文件系统）。
#
# 用法：
#   bash tools/wasm-build/export-data.sh                # 三个方案（默认）
#   bash tools/wasm-build/export-data.sh 27c            # 只要贰柒C
#   bash tools/wasm-build/export-data.sh 27c 27 keytao  # 显式列出
#
# 路径（环境变量都能覆盖；build-all.sh 会帮你把 XKJD_WORK 定好）：
#   XKJD_WORK          三个方案仓库 / flow_engine / build 所在目录（默认：网站仓库的上一级）
#   XKJD_SHARED        librime 共享数据（默认 /usr/share/rime-data）
#   XKJD_LUA           lua 引擎（默认 $XKJD_WORK/flow_engine/lua，三个方案共用一份）
#   XKJD_LAYOUT_TOOL   键位表工具（默认 $XKJD_WORK/flow_engine/tools/layout_image.py）
#   XKJD_WASMDATA      中间产物（默认 $XKJD_WORK/build/wasmdata，故意不在 docroot 里）
#   SOURCE_DATE_EPOCH  输入文件 mtime 统一钳到这个时间（默认固定值，保证镜像可复现）
#
# 依赖：rime_deployer（librime-bin）、python3 + lzma、/usr/share/rime-data；
#       只有生成 layouts.js 才需要 python3 的 Pillow（+ 该工具自己的 import）。
set -euo pipefail

# cd -P：允许从旧路径 tools/wasm-build（symlink）跑，不然 ../.. 会算错
SELF=$(cd -P "$(dirname "$0")" && pwd -P)
WEB=$(cd "$SELF/../.." && pwd)                        # 网站仓库根 = docroot
WORK=${XKJD_WORK:-$(dirname "$WEB")}
SHARED=${XKJD_SHARED:-/usr/share/rime-data}
ENGINE=${XKJD_ENGINE:-$WORK/flow_engine}
LUA_SRC=${XKJD_LUA:-$ENGINE/lua}
LAYOUT_TOOL=${XKJD_LAYOUT_TOOL:-$ENGINE/tools/layout_image.py}
OUT=${XKJD_WASMDATA:-$WORK/build/wasmdata}
IMG=$WEB/data
EPOCH=${SOURCE_DATE_EPOCH:-1704067200}                # 2024-01-01T00:00:00Z

die() { echo -e "✗ $*" >&2; exit 1; }

ALL_KEYS="27c 27 keytao"
scheme_repo() {                            # 键 -> 仓库目录
  case "$1" in
    27c)    echo rime_jd27c_flow ;;
    27)     echo rime_jd27_flow ;;
    keytao) echo rime_keytao_flow ;;
    *) die "不认识方案：$1（可用：$ALL_KEYS）" ;;
  esac
}
scheme_id() {                              # 键 -> schema_id
  case "$1" in
    27c)    echo xkjd27c_flow ;;
    27)     echo xkjd27_flow ;;
    keytao) echo keytao_flow ;;
  esac
}
scheme_keyboard() {                        # 键 -> 出图/网页用的键盘排列
  case "$1" in
    27c)    echo colemak ;;                # 贰柒C 就是给 Colemak 用户的
    *)      echo qwerty ;;
  esac
}

KEYS=${*:-$ALL_KEYS}
for k in $KEYS; do scheme_id "$k" >/dev/null; done

# ---- 0) 依赖和路径先查清楚，别跑到一半才发现 ----
command -v rime_deployer >/dev/null || die "没有 rime_deployer（Debian/Ubuntu：apt install librime-bin）"
python3 -c 'import lzma' 2>/dev/null || die "python3 缺 lzma 模块"
[ -f "$SHARED/default.yaml" ] || die "没有共享数据 $SHARED/default.yaml（装 librime-data，或用 XKJD_SHARED）"
[ -d "$LUA_SRC" ] || die "找不到 lua 引擎 $LUA_SRC（flow_engine 没 clone？用 XKJD_LUA / XKJD_ENGINE 指对目录）"
case "$OUT" in ""|/|"$HOME") die "XKJD_WASMDATA 指向 $OUT，不敢 rm -rf";; esac
[ "$OUT" != "$WEB" ] || die "XKJD_WASMDATA 不能等于网站仓库 $WEB"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/rime_export_XXXX")
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/user/lua"

# ---- 1) 把各方案的方案文件摊进同一个用户目录（文件名各不相同，不会撞） ----
echo "收集方案文件：$KEYS"
for k in $KEYS; do
  repo=$(scheme_repo "$k")
  src=$WORK/$repo/rime
  [ -d "$src" ] || die "找不到 $src（方案仓库没 clone？用 --work / XKJD_WORK 指对目录）"
  shopt -s nullglob
  files=("$src"/*.yaml "$src"/*.txt)
  shopt -u nullglob
  [ ${#files[@]} -gt 0 ] || die "$src 里没有 *.yaml / *.txt（方案仓库是空的？词库产物没提交？）"
  cp "${files[@]}" "$TMP/user/"
  echo "  $k <- $repo/rime（$(ls "$src"/*.yaml 2>/dev/null | wc -l) 个 yaml）"
done
cp "$LUA_SRC"/*.lua "$TMP/user/lua/"

# schema_list 永远列全三个方案（哪怕这次只打一个）：build/default.yaml 的内容与时间戳
# 因此与全量部署完全一致，base.img 在只打单个方案时也能原样复现。
# engine/filters 不在这里 patch —— 各方案 schema.yaml 自己带了 lua_filter@*flow_filter。
{
  printf 'patch:\n  schema_list:\n'
  for k in $ALL_KEYS; do printf '    - schema: %s\n' "$(scheme_id "$k")"; done
} > "$TMP/user/default.custom.yaml"

# 输入文件 mtime 统一钳到固定值：部署副本里的 __build_info.timestamps 和 prism 里的
# schema 校验和都由它算出，不钳的话每次跑出来的镜像字节都不一样（见 README「可复现」）。
find "$TMP/user" -exec touch -h -d "@$EPOCH" {} +

LOG=$WORK/build/rime_deployer.log
mkdir -p "$WORK/build"
echo "部署（生成 prism/table）…（日志 $LOG）"
# schema_list 里没 clone 的方案会报 "missing input schema"，不影响这次要打的那些
rime_deployer --build "$TMP/user" "$SHARED" "$TMP/user/build" >"$LOG" 2>&1 || true

for k in $KEYS; do
  id=$(scheme_id "$k")
  if ! ls "$TMP/user/build/$id".*.prism.bin >/dev/null 2>&1 ||
     ! ls "$TMP/user/build/$id".*.table.bin >/dev/null 2>&1; then
    echo "--- $LOG 末尾 ---" >&2
    tail -20 "$LOG" >&2
    die "$id 部署失败：user/build/ 里没有 prism/table（方案文件不全？词库产物没提交？）"
  fi
done

# wasm 里不带 opencc 数据，部署副本里的简化字转换摘掉
sed -i '/simplifier@jffh/d' "$TMP"/user/build/*.schema.yaml 2>/dev/null || true

# ---- 2) 组装镜像目录（只留运行时真的会读的文件） ----
rm -rf "$OUT"
mkdir -p "$OUT/shared" "$OUT/user/lua" "$OUT/user/build"
cp "$SHARED/default.yaml" "$SHARED/symbols.yaml" "$OUT/shared/" 2>/dev/null || true

# 运行时要读的：方案（含 flow_engine 键位）、形码表、单字表、次简表。
# 主词库源码（*.ice.dict.yaml / *.keytao.dict.yaml / *.simp.dict.yaml）只是部署的
# 输入，运行时不读，不进镜像；编译产物在 user/build/ 里。
for k in $KEYS; do
  id=$(scheme_id "$k")
  cp "$TMP/user/$id.schema.yaml" "$TMP/user/$id.shape.txt" \
     "$TMP/user/$id.danzi.dict.yaml" "$TMP/user/$id.shape.dict.yaml" \
     "$TMP/user/$id.secondary.yaml" "$OUT/user/"
done
cp "$TMP"/user/lua/*.lua "$OUT/user/lua/"
cp "$TMP"/user/build/* "$OUT/user/build/"

# 这份 patch 只在部署时有用（部署副本 build/default.yaml 和 build/<方案>.yaml 已经把
# schema_list / engine.filters 合进去了），运行时不读 —— 放在这里只是让内存文件系统里
# 的用户目录和真实安装一致。前端也不再写它。
{
  printf 'patch:\n  schema_list:\n'
  for k in $ALL_KEYS; do printf '    - schema: %s\n' "$(scheme_id "$k")"; done
  printf '  engine/filters:\n    - lua_filter@*flow_filter\n    - uniquifier\n'
} > "$OUT/user/default.custom.yaml"

# flow 方案运行时不读 *.reverse.bin（码表由 flow_codes.lua 从单字表 + 形码表自建），
# 而它是编译产物里最大的一块（7.4 MB，压缩后也占一半以上），所以导出后直接删掉。
# 注意：原生安装时 librime 每次部署都会重新生成它 —— 那是 librime 的
# dict_compiler 固定行为（缺了还会触发整表重建），别手动删本机的那份。
rm -f "$OUT"/user/build/*.reverse.bin
rm -rf "$OUT"/user/*.userdb "$OUT"/user/user.yaml   # 跑过探针留下的用户数据，别打进镜像
echo "导出到 $OUT"
du -sh "$OUT"

echo
echo "打包成压缩镜像（公共一份 + 每个方案一份，浏览器按需拉）…"
mkdir -p "$IMG"
pack() {  # pack <名字> <include...>
  local name=$1; shift
  local inc=()
  for pat in "$@"; do inc+=(--include "$pat"); done
  python3 "$SELF/pack-image.py" --src "$OUT" --out "$IMG/$name.img" \
      --exclude '*.reverse.bin' --exclude '*.userdb/*' --exclude 'user.yaml' \
      "${inc[@]}" | grep -E '文件|镜像|写出' | sed "s/^/  [$name] /"
}
# 公共：共享数据 + lua 引擎 + 配置（很小，开机就拉）
pack base 'shared/*' 'user/lua/*' 'user/default.custom.yaml' 'user/build/default.yaml'
# 每个方案一份：方案文件 + 词库产物（占体积的就是 build/*.table.bin / *.prism.bin）
for k in $KEYS; do
  id=$(scheme_id "$k")
  pack "$k" "user/$id.*" "user/build/$id.*"
done
echo
ls -la "$IMG" | awk 'NR>3 {printf "  %7.2f MB  %s\n", $5/1048576, $9}'

# ---- 3) 键位表给网页（与 docs/layout.png 同一份计算） ----
# 三个方案都导出（不管这次打的是谁）：layouts.js 是全量的，缺方案的 layout.py 就跳过那一个。
echo
echo "导出键位表 layouts.js…"
LAYOUT_FAIL=0
for k in $ALL_KEYS; do
  repo=$(scheme_repo "$k")
  if [ -f "$LAYOUT_TOOL" ] && [ -f "$WORK/$repo/layout.py" ]; then :; else
    echo "  ! 跳过 $k（缺 $LAYOUT_TOOL 或 $WORK/$repo/layout.py）"; LAYOUT_FAIL=1; continue
  fi
  python3 "$LAYOUT_TOOL" \
      --layout "$WORK/$repo/layout.py" \
      --shape-dict "$WORK/$repo/rime/$(scheme_id "$k").shape.dict.yaml" \
      --keyboard "$(scheme_keyboard "$k")" \
      --json "$TMP/layout-$k.json" || { echo "  ! $k 键位表出错"; LAYOUT_FAIL=1; }
done
if [ "$LAYOUT_FAIL" = 1 ]; then
  echo "  ! 有三个方案没算全，layouts.js 保持原样不动（别把另外两个方案的键位表覆盖没了）"
else
python3 - "$TMP" "$IMG/layouts.js" <<'PY'
import json, os, sys
src, out = sys.argv[1], sys.argv[2]
data = {}
for k in ('27', '27c', 'keytao'):
    with open(os.path.join(src, 'layout-%s.json' % k), encoding='utf-8') as fh:
        data[k] = json.load(fh)
with open(out, 'w', encoding='utf-8') as fh:
    fh.write('/* 由 tools/wasm-build/export-data.sh 生成：')
    fh.write('键位表来自各方案 layout.py + 纯形码表。和 docs/layout.png 同一份计算。 */\n')
    fh.write('window.FLOW_LAYOUTS = ')
    json.dump(data, fh, ensure_ascii=False, sort_keys=True, indent=1)
    fh.write(';\n')
print('写出 %s（%s）' % (out, ', '.join('%s %d 键' % (k, len(v['keys'])) for k, v in sorted(data.items()))))
PY
fi

# 镜像体积（网页上「首次点开要下 7.0 MB」那句话用）
python3 - "$IMG" <<'PY'
import os, sys
img = sys.argv[1]
sizes = {}
for name in sorted(os.listdir(img)):
    if name.endswith('.img') and name != 'base.img':
        mb = os.path.getsize(os.path.join(img, name)) / 1048576
        sizes[name[:-4]] = '%.1f MB' % mb
with open(os.path.join(img, 'sizes.js'), 'w', encoding='utf-8') as fh:
    fh.write('/* 由 tools/wasm-build/export-data.sh 生成：各方案镜像的体积。 */\n')
    fh.write('window.FLOW_IMAGE_SIZES = ')
    fh.write(repr(sizes).replace("'", '"'))
    fh.write(';\n')
print('写出 %s/sizes.js（%s）' % (img, sizes))
PY
