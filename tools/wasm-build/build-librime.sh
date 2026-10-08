#!/bin/bash
# 把 librime 1.13.1（含 lua 插件）编译成 wasm，产出 web/rime.js + web/rime.wasm
#
# 一般不用直接跑这个：build-all.sh 在 rime.js / rime.wasm 缺失（或 --rebuild-librime）时调它。
#
# 依赖：emsdk（emcc 在 PATH，或 XKJD_EMSDK 指到 emsdk 目录）、git、curl、cmake、python3
# 用法：bash tools/wasm-build/build-librime.sh
#   ROOT=<源码+编译缓存> 默认 $XKJD_WORK/wasm（= 网站仓库上一级的 wasm/，约 1.5 GB）
#                        别用 /tmp：本机 tmpfiles.d 会按 mtime 清掉下载解包的源码
#   OUT=<产物落点>       默认网站仓库根（web/）
set -euo pipefail

# cd -P：允许从旧路径 tools/wasm-build（symlink）跑，不然 ../.. 会算错
SELF=$(cd -P "$(dirname "$0")" && pwd -P)
WEB=$(cd "$SELF/../.." && pwd)
WORK=${XKJD_WORK:-$(dirname "$WEB")}
ROOT=${ROOT:-${XKJD_WASM_ROOT:-$WORK/wasm}}
OUT=${OUT:-$WEB}
SYS=$ROOT/sysroot
LOGS=$ROOT/logs
J=$(nproc)
EXC="-fexceptions"
BOOST_VER=1.84.0
LUA_VER=5.4.6
mkdir -p "$SYS" "$LOGS" "$ROOT/build" "$OUT"

if ! command -v emcc >/dev/null 2>&1; then
  for c in "${XKJD_EMSDK:-}" "$HOME/emsdk" /opt/emsdk /usr/lib/emsdk; do
    if [ -n "$c" ] && [ -f "$c/emsdk_env.sh" ]; then
      echo "source $c/emsdk_env.sh"
      set +u; . "$c/emsdk_env.sh" >/dev/null 2>&1 || true; set -u
      break
    fi
  done
fi
command -v emcc >/dev/null 2>&1 || {
  echo "✗ 没有 emcc：装 emsdk（https://emscripten.org/docs/getting_started/downloads.html）" >&2
  echo "  然后 source <emsdk>/emsdk_env.sh；或用 XKJD_EMSDK=<emsdk 目录> 指路" >&2
  exit 1
}

say() { echo -e "\n===== $* ====="; }

# ---------------------------------------------------------------- 源码
if [ ! -d "$ROOT/librime/src" ]; then
  say "clone librime 1.13.1"
  git clone -q --depth 1 -b 1.13.1 --recurse-submodules --shallow-submodules \
      https://github.com/rime/librime.git "$ROOT/librime"
fi
if [ ! -d "$ROOT/librime-lua/src" ]; then
  say "clone librime-lua"
  git clone -q --depth 1 https://github.com/hchunhui/librime-lua.git "$ROOT/librime-lua"
fi
if [ ! -d "$ROOT/lua-$LUA_VER/src" ]; then
  say "download lua $LUA_VER"
  curl -sL -o "$ROOT/lua.tar.gz" "https://www.lua.org/ftp/lua-$LUA_VER.tar.gz"
  tar xzf "$ROOT/lua.tar.gz" -C "$ROOT"
fi
if [ ! -d "$ROOT/boost_1_84_0/boost" ]; then
  say "download boost $BOOST_VER（只用它的头文件 + regex）"
  curl -sL -o "$ROOT/boost.tar.gz" \
    "https://archives.boost.io/release/$BOOST_VER/source/boost_$(echo $BOOST_VER | tr . _).tar.gz"
  tar xzf "$ROOT/boost.tar.gz" -C "$ROOT"
fi
BOOST=$ROOT/boost_$(echo "$BOOST_VER" | tr . _)   # 解包出来是 boost_1_84_0

# ---------------------------------------------------------------- 补丁
say "patch：emscripten 下的三处小改动"
python3 - "$ROOT" <<'PY'
import sys, os
ROOT = sys.argv[1]
# 1) boost.interprocess：wasm 没有 System V 共享内存
p = f'{ROOT}/boost_1_84_0/boost/interprocess/detail/workaround.hpp'
s = open(p).read()
if '__EMSCRIPTEN__' not in s:
    s = s.replace('&& !(__VXWORKS__)\n', '&& !(__VXWORKS__) && !defined(__EMSCRIPTEN__)\n', 1)
    open(p, 'w').write(s)
# 2) opencc 自带的 rapidjson 1.1.0 在新 clang 上编不过
p = f'{ROOT}/librime/deps/opencc/deps/rapidjson-1.1.0/rapidjson/document.h'
s = open(p).read()
old = 'GenericStringRef& operator=(const GenericStringRef& rhs) { s = rhs.s; length = rhs.length; }'
if old in s:
    open(p, 'w').write(s.replace(old, 'GenericStringRef& operator=(const GenericStringRef& rhs) { s = rhs.s; }'))
# 3) lua 插件：wasm 里没有 dlopen/POSIX；lua 源码要平铺到 thirdparty/lua5.4
p = f'{ROOT}/librime/plugins/lua/CMakeLists.txt'
if not os.path.exists(p):
    os.makedirs(f'{ROOT}/librime/plugins', exist_ok=True)
    os.system(f'cp -r {ROOT}/librime-lua {ROOT}/librime/plugins/lua')
    os.system(f'rm -rf {ROOT}/librime/plugins/lua/.git')
    os.makedirs(f'{ROOT}/librime/plugins/lua/thirdparty/lua5.4', exist_ok=True)
    os.system(f'cp {ROOT}/lua-5.4.6/src/*.c {ROOT}/lua-5.4.6/src/*.h {ROOT}/librime/plugins/lua/thirdparty/lua5.4/')
    os.remove(f'{ROOT}/librime/plugins/lua/thirdparty/lua5.4/lua.c')
    os.remove(f'{ROOT}/librime/plugins/lua/thirdparty/lua5.4/luac.c')
    s = open(p).read()
    s = s.replace("""  else()
    set_property(SOURCE ${LUA_SRC} PROPERTY COMPILE_DEFINITIONS LUA_USE_POSIX;LUA_USE_DLOPEN)""",
                  """  elseif(EMSCRIPTEN)
    # wasm: 不用 POSIX / dlopen
  else()
    set_property(SOURCE ${LUA_SRC} PROPERTY COMPILE_DEFINITIONS LUA_USE_POSIX;LUA_USE_DLOPEN)""")
    open(p, 'w').write(s)
print('patched')

# 4) 部署进度回调 + 跳过 flow 方案用不到的反查表
#    （wasm 里在线部署时前端要进度条；reverse 我们不读，建它纯浪费时间）
p = f'{ROOT}/librime/src/rime/dict/entry_collector.cc'
s = open(p).read()
if 'RIME_WASM_PROGRESS' not in s:
    s = s.replace('namespace rime {',
                  'extern "C" void rime_deploy_progress(const char* phase, long long done, long long total);\n'
                  '#define RIME_WASM_PROGRESS(p, d, t) rime_deploy_progress(p, d, t)\n\n'
                  'namespace rime {', 1)
    s = s.replace("""  while (getline(fin, line)) {
    boost::algorithm::trim_right(line);
    line_number++;""",
"""  std::streampos file_size = 0;
  {
    fin.seekg(0, std::ios::end);
    file_size = fin.tellg();
    fin.seekg(0, std::ios::beg);
    RIME_WASM_PROGRESS("collect", 0, (long long)file_size);
  }
  while (getline(fin, line)) {
    boost::algorithm::trim_right(line);
    line_number++;
    if ((line_number & 0x3ff) == 0) {
      RIME_WASM_PROGRESS("collect", (long long)fin.tellg(), (long long)file_size);
    }""", 1)
    open(p, 'w').write(s)

p = f'{ROOT}/librime/src/rime/dict/dict_compiler.cc'
s = open(p).read()
if 'RIME_WASM_PROGRESS' not in s:
    s = s.replace('namespace rime {',
                  'extern "C" void rime_deploy_progress(const char* phase, long long done, long long total);\n'
                  '#define RIME_WASM_PROGRESS(p, d, t) rime_deploy_progress(p, d, t)\n\n'
                  'namespace rime {', 1)
    s = s.replace("""    for (const auto& r : collector.entries) {
      Code code;""",
"""    long long total_entries = (long long)collector.entries.size();
    long long done_entries = 0;
    RIME_WASM_PROGRESS("vocabulary", 0, total_entries);
    for (const auto& r : collector.entries) {
      if ((++done_entries & 0x1fff) == 0) {
        RIME_WASM_PROGRESS("vocabulary", done_entries, total_entries);
      }
      Code code;""", 1)
    s = s.replace("""    table->Remove();
    if (!table->Build(""",
"""    table->Remove();
    RIME_WASM_PROGRESS("table", 0, 1);
    if (!table->Build(""", 1)
    s = s.replace("""  // build reverse db for the primary table
  if (table_index == 0 &&
      !BuildReverseDb(settings, collector, vocabulary, dict_file_checksum)) {""",
"""  // build reverse db for the primary table
  // （wasm/flow：不用反查表，跳过 —— 省掉 7.4 MB 产物和一大半构建时间）
  if (false && table_index == 0 &&
      !BuildReverseDb(settings, collector, vocabulary, dict_file_checksum)) {""", 1)
    s = s.replace('  LOG(INFO) << "building prism...";',
                  '  LOG(INFO) << "building prism...";\n  RIME_WASM_PROGRESS("prism", 0, 1);', 1)
    open(p, 'w').write(s)
print('patched (progress hooks + skip reverse)')
PY

# ---------------------------------------------------------------- 依赖
cb() { # name srcdir args...
  local n=$1 s=$2; shift 2
  say "build $n"
  emcmake cmake "$s" -B "$ROOT/build/$n" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$SYS" \
    -DCMAKE_CXX_STANDARD=17 -DCMAKE_C_FLAGS="$EXC" -DCMAKE_CXX_FLAGS="$EXC" "$@" \
    > "$LOGS/$n.cmake.log" 2>&1
  cmake --build "$ROOT/build/$n" --parallel "$J" --target install >> "$LOGS/$n.cmake.log" 2>&1
  echo "  ok"
}
cb yaml-cpp "$ROOT/librime/deps/yaml-cpp" -DYAML_CPP_BUILD_TESTS=OFF -DYAML_CPP_BUILD_TOOLS=OFF -DYAML_CPP_BUILD_CONTRIB=OFF
cb leveldb  "$ROOT/librime/deps/leveldb"  -DBUILD_SHARED_LIBS=OFF -DLEVELDB_BUILD_TESTS=OFF -DLEVELDB_BUILD_BENCHMARKS=OFF
cb marisa   "$ROOT/librime/deps/marisa-trie" -DBUILD_SHARED_LIBS=OFF
say "build opencc（只要库，它的命令行工具在 wasm 下链不过）"
emcmake cmake "$ROOT/librime/deps/opencc" -B "$ROOT/build/opencc" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_STANDARD=17 -DCMAKE_C_FLAGS="$EXC" -DCMAKE_CXX_FLAGS="$EXC" \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DENABLE_GTEST=OFF > "$LOGS/opencc.cmake.log" 2>&1
cmake --build "$ROOT/build/opencc" --target libopencc --parallel "$J" >> "$LOGS/opencc.cmake.log" 2>&1
cp "$ROOT/build/opencc/src/libopencc.a" "$SYS/lib/"
mkdir -p "$SYS/include/opencc"        # 第一次跑（干净缓存）时这个目录还不存在
cp "$ROOT/build/opencc/src/Opencc_Export.h" "$ROOT/build/opencc/src/opencc_config.h" "$SYS/include/opencc/"
cp "$ROOT/librime/deps/opencc/src/"*.hpp "$ROOT/librime/deps/opencc/src/opencc.h" "$SYS/include/opencc/"
echo "  ok"

# ---------------------------------------------------------------- librime
say "build librime（静态 + 合并 lua 插件）"
emcmake cmake "$ROOT/librime" -B "$ROOT/build/librime" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$SYS" -DCMAKE_CXX_STANDARD=17 \
  -DCMAKE_C_FLAGS="$EXC" -DCMAKE_CXX_FLAGS="$EXC -DBOOST_REGEX_STANDALONE -DBOOST_ALL_NO_LIB" \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC=ON -DBUILD_MERGED_PLUGINS=ON \
  -DBUILD_TEST=OFF -DBUILD_SAMPLE=OFF -DBUILD_DATA=OFF \
  -DENABLE_LOGGING=OFF -DENABLE_THREADING=OFF -DENABLE_EXTERNAL_PLUGINS=OFF \
  -DBoost_NO_BOOST_CMAKE=ON -DBOOST_ROOT="$BOOST" -DBoost_INCLUDE_DIR="$BOOST" -DBoost_LIBRARY_DIR="$SYS/lib" \
  -DOpencc_INCLUDE_PATH="$SYS/include" -DOpencc_LIBRARY="$SYS/lib/libopencc.a" \
  -DYamlCpp_INCLUDE_PATH="$SYS/include" -DYamlCpp_NEW_API="$SYS/include/yaml-cpp/node/node.h" \
  -DYamlCpp_LIBRARY="$SYS/lib/libyaml-cpp.a" \
  -DLevelDb_INCLUDE_PATH="$SYS/include" -DLevelDb_LIBRARY="$SYS/lib/libleveldb.a" \
  -DMarisa_INCLUDE_PATH="$SYS/include" -DMarisa_LIBRARY="$SYS/lib/libmarisa.a" \
  > "$LOGS/librime.cmake.log" 2>&1
cmake --build "$ROOT/build/librime" --parallel "$J" > "$LOGS/librime.build.log" 2>&1
echo "  ok"

# ---------------------------------------------------------------- 链接
say "编 LZMA 解码器（压缩镜像用）"
emcc -O2 -c "$SELF/lzma/Lzma2Dec.c" -o "$ROOT/build/lzma2dec.o"
emcc -O2 -c "$SELF/lzma/LzmaDec.c"  -o "$ROOT/build/lzmadec.o"
echo "  ok"

say "链接 wasm 模块"
em++ -O2 -std=c++17 -fexceptions -DBOOST_REGEX_STANDALONE -DBOOST_ALL_NO_LIB \
  -I "$SYS/include" -I "$ROOT/librime/src" -I "$ROOT/librime/include" \
  -I "$ROOT/build/librime/src" -I "$BOOST" \
  "$SELF/api.cpp" "$ROOT/build/lzma2dec.o" "$ROOT/build/lzmadec.o" "$ROOT/build/librime/lib/librime.a" \
  "$SYS/lib/libyaml-cpp.a" "$SYS/lib/libleveldb.a" "$SYS/lib/libmarisa.a" "$SYS/lib/libopencc.a" \
  -o "$OUT/rime.js" \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sSTACK_SIZE=8388608 \
  -sFORCE_FILESYSTEM=1 -sMODULARIZE=1 -sEXPORT_NAME=createRime -sENVIRONMENT=web \
  -sEXPORTED_FUNCTIONS=_rime_wasm_init,_rime_wasm_select,_rime_wasm_key,_rime_wasm_clear,_rime_wasm_input,_rime_wasm_commit,_rime_wasm_state,_rime_wasm_schema_list,_rime_wasm_reset_user,_rime_wasm_reset_user_of,_rime_wasm_shutdown,_rime_wasm_mount_file,_rime_wasm_mount_begin,_rime_wasm_mount_step,_rime_wasm_mount_finish,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,UTF8ToString

ls -la "$OUT/rime.js" "$OUT/rime.wasm"
say "完成"
