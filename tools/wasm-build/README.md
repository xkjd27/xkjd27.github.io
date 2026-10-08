# 打 img 的工具链（浏览器里的 librime）

网页里的候选 / 提示 / 顶功 / 排码 / 造词全是**真 librime 1.13.1 + lua 插件**（wasm）现算的。
这套脚本负责两件事：

1. 把 librime 编成 wasm（`rime.js` / `rime.wasm`，很少需要重编）；
2. 把三个方案打成四个 `.img` 镜像放进网站仓库的 `data/`（**这就是「打 img」**）。

目标读者是半年后的自己：照着下面跑就行，不用再翻代码。设计取舍、踩过的坑都在
「镜像格式」「常见故障」两节里。

---

## 一条命令

```sh
cd <网站仓库根>          # 就是有 index.html / data/ 的那层（本机 /root/xkjd27/web）
bash tools/wasm-build/build-all.sh
```

它会依次做：**① 拉/更新三个方案仓库（含 engine/ 子模块）→ ② 需要时才编 librime wasm →
③ 三个方案摊进同一个 rime 用户目录、`rime_deployer` 部署一次 → ④ 拆成四个镜像写进
`data/`，顺带重写 `data/layouts.js`、`data/sizes.js` → ⑤ 打印大小和 md5**。

本机实测：全量（复用已 clone 的仓库、跳过 librime 编译）≈ 45 秒；干净目录从头 clone
三个方案仓库 ≈ 1 分半。**打 img 不需要重建词库**，方案仓库里已提交编译好的 `rime/*.dict.yaml`。

常用变体：

| 命令 | 干什么 |
| --- | --- |
| `bash tools/wasm-build/build-all.sh --only 27c` | 只重打贰柒C（≈ 20 秒）。`base.img` 会一起重打，内容与全量一致 |
| `bash tools/wasm-build/build-all.sh --no-update` | 不 clone / 不 fetch，用现有 checkout（离线可跑） |
| `bash tools/wasm-build/build-all.sh --work /path/to/work` | 换工作目录（方案仓库、flow_engine、中间产物都在那里） |
| `bash tools/wasm-build/build-all.sh --rebuild-librime` | 强制重编 `web/rime.js` + `web/rime.wasm` |
| `bash tools/wasm-build/build-all.sh --only 27 27c` | 方案可以列多个：`27c` / `27` / `keytao` |

`-h` 看全部选项。也可以只跑中间那半（已经 clone 好了、只想重打镜像）：

```sh
bash tools/wasm-build/export-data.sh          # 三个方案，直接写 web/data/*.img
bash tools/wasm-build/export-data.sh 27c      # 只打 27c
```

---

## 依赖

干净机器上从头跑通，需要这些东西（Linux；macOS 没试过，`touch -d @…` 和
`/usr/share/rime-data` 这两处是 Linux 习惯）：

| 依赖 | 干什么用 | 装法（Debian/Ubuntu） |
| --- | --- | --- |
| `git` + 能上 GitHub | 拉三个方案仓库 + flow_engine | `apt install git` |
| `python3`（带 `lzma` 模块） | `pack-image.py` 压镜像；脚本里的杂活 | `apt install python3`（官方包自带 lzma） |
| `rime_deployer` | 部署方案，生成 prism/table | `apt install librime-bin` |
| librime 共享数据 | 部署的输入（`default.yaml` / `symbols.yaml`） | `apt install librime-data`（装在 `/usr/share/rime-data`） |
| `python3-pil` / `python3-yaml` | 只有生成 `data/layouts.js` 时用（键位表工具要 Pillow） | `apt install python3-pil python3-yaml` |
| **emsdk**（`emcc`） | **只有要重编 wasm 时才要** | <https://emscripten.org> 下载后 `source emsdk_env.sh` |
| `cmake` / `make` / `curl` | 同上（emscripten 的 cmake 工具链 + 下 librime/boost/lua 源码） | `apt install cmake make curl` |

* 脚本缺 `emcc` 时会自己去找 `$XKJD_EMSDK`、`~/emsdk`、`/opt/emsdk` 里的 `emsdk_env.sh`
  并 source 它；都没有就报错告诉你怎么办。
* `rime.js` / `rime.wasm` 已经提交在仓库里，所以**平时（只是改了 lua / 方案 / 词库）根本不用 emsdk**。
* 磁盘：中间产物 ~34 MB、三个方案仓库 ~150 MB、librime 的源码+编译缓存 ~1.5 GB
  （默认在 `$XKJD_WORK/wasm`）。
* 网络只在第 ① 步和第一次编 wasm 时需要；`--no-update` 可以完全离线打镜像。

---

## 路径与环境变量

所有路径都算出来给你看（`build-all.sh` 开头会打印三行），也能用环境变量覆盖：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `XKJD_WORK` | 见下 | 方案仓库（`rime_jd27c_flow` / `rime_jd27_flow` / `rime_keytao_flow`）、`flow_engine`、中间产物都在这里 |
| `XKJD_WASM_ROOT` | `$XKJD_WORK/wasm` | librime 源码 + 编译缓存（`build-librime.sh` 的 `ROOT`，约 1.5 GB）；删掉就是从零编。**别放 `/tmp`**，见「常见故障」 |
| `XKJD_SHARED` | `/usr/share/rime-data` | librime 共享数据 |
| `XKJD_LUA` | `$XKJD_WORK/flow_engine/lua` | lua 引擎（三个方案共用一份，base.img 里装的就是它） |
| `XKJD_LAYOUT_TOOL` | `$XKJD_WORK/flow_engine/tools/layout_image.py` | 键位表工具（`--json` 那个选项只有 flow_engine master 上有） |
| `XKJD_WASMDATA` | `$XKJD_WORK/build/wasmdata` | 部署/导出的中间散文件（**故意不在 docroot 里**，34 MB 不该跟着上传） |
| `SOURCE_DATE_EPOCH` | `1704067200` | 输入文件 mtime 统一钳到这一刻，保证镜像可复现（见「可复现」） |

`XKJD_WORK` 的默认值按顺序挑：`--work` > `$XKJD_WORK` > **网站仓库的上一级**（如果那里
已经有方案仓库，本机 `/root/xkjd27` 就是这种）> `$XDG_CACHE_HOME/xkjd27`（干净机器上
从零 clone 到这里）。

仓库布局（打 img 用到的就这些）：

```
<XKJD_WORK>/
  rime_jd27c_flow/    rime/*.yaml + rime/*.txt + layout.py   ← 方案仓库（GitHub）
  rime_jd27_flow/
  rime_keytao_flow/
  flow_engine/        lua/ + tools/layout_image.py           ← 引擎仓库（GitHub）
  build/wasmdata/     export-data.sh 的中间产物（34 MB，别提交）
  build/rime_deployer.log                                    ← 部署日志，出错先看它
```

`engine/` 子模块是各方案 pin 的引擎版本（`--recurse-submodules` 会拉，**打 img 不用它**；
lua 和键位表工具都从 `flow_engine` 的 master 取，一份引擎服务三个方案）。

---

## 产出（这些文件是自动生成的，别手改）

| 文件 | 谁生成 | 说明 |
| --- | --- | --- |
| `web/data/base.img` | `export-data.sh` | **公共镜像**：共享数据 + lua 引擎 + 配置（~30 KB，进页面就挂） |
| `web/data/27c.img` `27.img` | 同上 | 贰柒C / 贰柒：方案文件 + 词库产物（各 ~7 MB，点 tab 才拉） |
| `web/data/keytao.img` | 同上 | 键道（~1.1 MB） |
| `web/data/layouts.js` | 同上 | 键位表（键位图 + 体验模式「哪些键交给引擎」都读它）+ 三套方案共用的纯形码表（`FLOW_SHAPES`，各方案只记笔形键的落键 `shapeMap`） |
| `web/data/sizes.js` | 同上 | 各镜像体积（页面上「首次点开要下 7.0 MB」那句话） |
| `web/rime.js` `web/rime.wasm` | `build-librime.sh` | librime + lua + LZMA 解码器的 wasm 模块（~2.7 MB） |
| `web/data/demos.js` | **不是这套脚本** | 演示剧本，由 `tools/record_demo.py` 录出来（另一个工具链，在仓库外） |

这些文件都提交在 git 里（`demos.js` 也在，但它是另一个工具链生成的），所以「改了 lua / 方案 /
词库 → 重打 img → 看 diff → 提交」是正常流程；手改 img 会在下次打 img 时被覆盖。

---

## 它到底做了什么

```
build-all.sh
 ├─ ① 三个方案仓库 + flow_engine：已有就 fetch + merge --ff-only + 子模块 update，没有就 clone
 │     （本地有未提交改动 → 只警告不动它；拉不动 → 用现有 checkout 继续）
 ├─ ② rime.js/rime.wasm 已存在 → 跳过；否则 build-librime.sh（源码在 $XKJD_WASM_ROOT）
 ├─ ③ export-data.sh
 │    a. 各方案的 rime/*.yaml rime/*.txt 摊进同一个用户目录；lua 引擎复制一份
 │    b. 把所有输入文件 mtime 钳到 $SOURCE_DATE_EPOCH（可复现的关键，见下）
 │    c. rime_deployer --build 部署一次 → user/build/ 里每个方案一份 prism/table
 │    d. 只留运行时真的会读的文件，删掉 *.reverse.bin 和跑探针留下的用户数据
 │    e. pack-image.py 按 include 拆分：base.img（公共）+ 每个方案一个 .img
 │    f. layouts.js（三个方案的 layout.py + 形码表）+ sizes.js（镜像体积）
 └─ ④ 打印四个 img 的大小和 md5
```

* `default.custom.yaml` 里的 `schema_list` **永远列全三个方案**（哪怕 `--only 27c`），
  所以 `base.img` 里那份 `build/default.yaml` 在单打和多打时字节一样；缺的方案
  `rime_deployer` 只会报 `missing input schema`（正常，见部署日志）。
* 部署副本里的 `simplifier@jffh` 会被删掉（公开版不带 opencc 数据，wasm 里也没有）。
* 三个方案装在**同一个用户目录**里（跟真实用户把三个方案都装上一样），引擎按 schema
  缓存互不污染；这条有专门的台架验证，见 `tools/flow_engine_test.md`。

### 可复现（为什么两次跑出来的 img 一模一样）

`__build_info.timestamps` 记的是输入文件的 mtime，`prism.bin` 头里还存着**方案 yaml 的
校验和**（`schema_file_checksum`，因为它就是由 scheme yaml 内容算的）。不钳 mtime 的话，
每次跑的镜像字节都不一样（内容等效，但 md5 变）。所以：

* 部署前 `find $TMP/user -exec touch -d @$SOURCE_DATE_EPOCH {} +`：所有输入同一时刻；
* 于是 `default.yaml` / `<方案>.schema.yaml` / `*.prism.bin` 全部可复现；
* `table.bin` 本来就是内容决定的，跟时间无关。

实测：连跑两次 `build-all.sh`，四个 img 的 md5 完全一致；换一个干净的工作目录
（从头 clone 方案仓库）再跑，md5 还是同一组。**改动 `SOURCE_DATE_EPOCH` 会让 img 变**，
平时别动它。

（小提示：librime 记下来的时间戳比 `touch` 给的少 1 秒（1704067200 → 1704067199），
是 libstdc++ 的 `file_time` 转换取整，不影响什么 —— 只要每次一样就行。）

---

## 镜像格式（`api.cpp` 的 `rime_wasm_mount()` 对应）

```
0   char[8]  "XKJDRIMG"
8   u32      version=1
12  u32      payload   解压后长度
16  u32      packed    压缩流长度
20  u32      dict      LZMA2 字典（解码窗口）
24  u8       props     LZMA2 属性字节 (pb*5+lp)*9+lc
25  u8[3]    pad
28  ...      原始 LZMA2 流

解出来是「文件流」：u32 path_len | path | u32 size | data ... u32 0
```

路径按内存文件系统里的绝对路径存（`build/wasmdata/shared/x` → `/shared/x`）。
各 img 的文件名互不重叠，所以可以先后挂进同一个内存文件系统：

| 镜像 | 内容 | 什么时候拉 |
| --- | --- | --- |
| `base.img` | `shared/` + `user/lua/` + `default.custom.yaml` + `build/default.yaml` | 进页面（几十 KB） |
| `<方案>.img` | 该方案的 yaml / 单字表 / 形码表 / 声笔简码默认表 / 次简表 + `build/<方案>.*` | 点它的 tab 时 |

`<方案>.img` 里那几份 yaml **少一份对应的功能就整个失灵**：lua 引擎运行时直接读它们
（`flow_codes.lua` 读 `.danzi.dict.yaml` + `.shape.dict.yaml`，`flow_shengbi.lua` 读
`.shengbi.dict.yaml`，`flow_secondary.lua` 读 `.secondary.yaml`），而 `.ice.dict.yaml` /
`.simp.dict.yaml` 这类主词库源码只是部署的输入、运行时不读，不进镜像（编译产物在
`build/` 里）。加新数据文件时记得同步 `export-data.sh` 里的 `cp` 清单。

拉完新镜像后前端会 `rime_wasm_shutdown()` + `rime_wasm_init()` 重启一次引擎
再 `select_schema()` —— 方案文件是 initialize 之后才挂上的，重来一遍最稳。

```sh
python3 tools/wasm-build/pack-image.py --src $XKJD_WORK/build/wasmdata --out web/data/27c.img \
    --include 'user/xkjd27c_flow.*' --include 'user/build/xkjd27c_flow.*'
python3 tools/wasm-build/pack-image.py --help      # --include / --exclude / --dict
```

为什么是 LZMA2（实测 14.9 MB 数据）：

| 方案 | 体积 | 解码器 | 浏览器里解压 |
| --- | --- | --- | --- |
| **xz/LZMA2 -9e** | **7.10 MB** | LZMA SDK `Lzma2Dec`（两个 .c，wasm 里约 15 KB） | **0.55 s** |
| zstd -19 | 8.7 MB | zstd 解码器（大得多） | ~0.1 s |
| gzip -9（可用浏览器原生 `DecompressionStream`） | 14.6 MB | 0（浏览器自带） | — |
| bzip2 -9 / PPMd | 14.1 / 13.7 MB | — | — |

* 文件之间是**连续压**（solid），LZMA 的窗口覆盖整包；试过把 table / prism 按
  64K~1M 块交错，反而略差 —— 两份 trie 的字节并不相似，跨文件匹配只有 ~1%。
* 字典 8 MiB 就够（解码器要分配这么多内存）；实测 16 / 32 / 64 MiB 只多省 1 KB，
  所以默认就是 8 MiB。
* 两个坑：`Lzma2Dec_Allocate()` 收的是 **7-Zip 那套「字典大小」属性字节**，
  我们这种 xz 风格的 raw 流要自己拼 5 字节 LZMA1 属性（`lc/lp/pb` + 字典大小）再分配；
  镜像里 `mkdir_p()` 只建父目录（一开始把文件名也建成了目录，`fopen` 全失败）。
* 镜像缺失 / 坏掉没有兜底：`loadRimeData()` 直接抛错，页面显示「启动失败：…」。

### 分片解压（给前端进度条用）

`begin / step / finish` 拆开就是为了**一边解压一边刷进度条**：
`web/rime-data.js` 每次 `step(256 KiB)`，然后在两步之间 `await setTimeout(0)` 让出主线程，
浏览器就有机会重绘。实测（浏览器里 14.9 MB 负载）：

```
 60 ms  50%  镜像 7.10 MB，解压中…
145 ms  61%  解压 3.5 / 14.9 MB
...
711 ms  95%  解压 14.9 / 14.9 MB
```

分片比一口气解完只慢 ~0.15 s（549 ms → 711 ms），换来的是一条会动的进度条。

---

## 编译 librime（`build-librime.sh`，很少需要跑）

```sh
source ~/emsdk/emsdk_env.sh          # 需要 emcc（脚本也会自己找 emsdk）
bash tools/wasm-build/build-librime.sh
# ROOT=<源码+编译缓存>（默认 $XKJD_WORK/wasm，同 build-all.sh；别用 /tmp）
# OUT=<产物落点>（默认网站仓库根）
```

脚本会自己下载 librime 1.13.1（含 deps 子模块）、librime-lua、Lua 5.4.6、boost 1.84，
打三处小补丁后再编：

1. `boost/interprocess` —— wasm 没有 System V 共享内存，关掉 XSI 分支；
2. opencc 自带的 rapidjson 1.1.0 —— 新 clang 编不过的 const 成员赋值；
3. lua 插件 —— 去掉 `LUA_USE_POSIX` / `LUA_USE_DLOPEN`，并把 lua 源码平铺进 `thirdparty/lua5.4`。

其它几个坑（脚本里已经处理）：

* 全部依赖都要带 `-fexceptions` 编：librime 会 throw/catch，关掉异常会直接 abort；
* lua 插件是 `OBJECT` 库合并进 librime 静态库的，**没人引用就会被链接器丢掉**，
  所以 `api.cpp` 里故意调了一下 `rime_require_module_lua()`（注意它是 C++ 链接的 mangled 符号）；
* opencc 的命令行工具在 wasm 下链不过（`-pthread` 冲突），只需要它的库，所以单独 build `libopencc` 再手工装；
* boost.regex 用 `BOOST_REGEX_STANDALONE`（1.84 里它就是头文件实现，不需要编库）。

实测（2026-10-08，emcc 6.0.9）：**从空目录起**（自己下载 librime / lua / boost）到链接完成
约 8 分钟（机器负载低时），其中 librime 编译占大头；缓存建好后重跑只要几十秒（增量）。

注意 `rime.wasm` 会**把源码的绝对路径编进去**（marisa 的断言字符串等），所以：

* 同一个 `XKJD_WASM_ROOT` 路径重编 → 字节一致（已验证）；
* 换了缓存路径再编 → md5 会变（内嵌路径不同，整个二进制偏移跟着变），功能一样，
  不用因为 md5 变了去查代码。`rime.js`（胶水）不受影响。

一个正好踩过的坑：**部署流程里没有用到的第 4 个补丁**（给 librime 插部署进度回调 +
跳过反查表）现在没有副作用，但 `api.cpp` 里留了个空的 `rime_deploy_progress()` ——
删掉会链接失败，别动。

---

## C API（`api.cpp`）

| 函数 | 说明 |
| --- | --- |
| `rime_wasm_init(shared_dir, user_dir)` | 初始化（不跑部署，产物是预编译好的） |
| `rime_wasm_select(schema_id)` | 建会话 + 选方案 |
| `rime_wasm_key(keycode, mask)` | 送一个按键（可打印字符就是 ASCII，空格 0x20、Tab 0xff09、退格 0xff08） |
| `rime_wasm_commit()` | 取走上屏文本（取一次就没了） |
| `rime_wasm_state()` | 当前状态 JSON：`{input, preedit, candidates:[{text, comment}]}` |
| `rime_wasm_clear()` | 清空当前输入 |
| `rime_wasm_reset_user()` | **用户数据复位**：销毁会话 → 删掉 `<user>/*.userdb`（排码 / 次简 / 造词记录）与 `*.order.txt` → 返回删掉的条目数；之后要再调 `rime_wasm_select()` 建会话 |
| `rime_wasm_shutdown()` | 关掉引擎（会话 + librime），之后可以再 `rime_wasm_init` 一次（网页换方案镜像用） |
| `rime_wasm_reset_user_of(schema_id)` | 只清某个方案的用户数据（多方案同装一个用户目录时，别误删别人的） |
| `rime_wasm_mount_begin(path)` | **挂载镜像（第 1 步）**：读镜像、解析头、分配缓冲 → 返回解压后长度（<0 错误） |
| `rime_wasm_mount_step(budget)` | **挂载镜像（第 2 步）**：最多再解 `budget` 字节输入 → 返回已解出的总字节数（`budget<=0` 一次解完） |
| `rime_wasm_mount_finish()` | **挂载镜像（第 3 步）**：把解出来的文件流展开进内存文件系统 → 返回文件数 |
| `rime_wasm_mount_file(path)` | 一次跑完（= begin + step(0) + finish），不分片时用它 |

在线部署用的 `rime_wasm_deploy_*` 已经删掉了（浏览器里不做部署：没有 `*.dict.yaml` 源码，
也不带 opencc）。用法见 `web/index.html`：`M.FS.writeFile()` 写内存文件系统，`M.ccall(...)` 调函数。

### 复位为什么要按这个顺序

`rime_wasm_reset_user()` 是**先销毁会话再删文件**：

* 会话销毁时 lua 组件的析构会跑 `fini`（`flow_shape.lua` 和 `flow_filter.lua` 各一次），
  引用计数归零后 `flow_order.close()` 才真正关掉 leveldb；
* 反过来先删还在写的库，leveldb 在 `close()` 时会把 MANIFEST / CURRENT 又写回来，数据没删干净；
* 少写一个 `fini`（比如只给 `flow_shape.lua` 写）引用计数就永远差 1，库一直开着 ——
  这也正是 `tools/order-orderdb-sync.md` 里同进程同步撞 LOCK 的原因。

---

## 验证打出来的 img

```sh
cd <网站仓库根> && python3 -m http.server 3444        # 纯静态，没有后端
```

打开 <http://127.0.0.1:3444/>（不带 `?v=` 用 `index.html` 里的 `BUILD`，`?v=N` 覆盖它穿透
缓存），滚到「试打」区：

* 状态显示「就绪」/ 控制台 `window.__ready === true`（base + 当前方案的 img 都挂上了）；
* 三个 tab 都点一遍：键位图、候选、上屏都正常，点「体验」随便打两个键要出候选；
* 要逐键看引擎状态就开控制台（预览实例挂在 `window.__ime` 上）：

  ```js
  __ime.current       // 当前方案 keytao / 27 / 27c
  __ime.feed('n')     // 喂一个键：{ commit, st }
  __ime.stateNow()    // { input, preedit, candidates, page, ... }
  __ime.call('rime_wasm_schema_list', 'string', [], [])
  __ime.M.FS.readdir('/user')   // 挂进内存文件系统的文件
  ```

**改了 data/*.js 记得把 `index.html` 里的 `BUILD` +1**，不然老访客继续吃缓存。

---

## 常见故障

| 症状 | 原因 / 处理 |
| --- | --- |
| `找不到 $WORK/rime_jd27c_flow/rime`（或 `flow_engine/lua`） | 方案仓库没 clone。第一次跑别加 `--no-update`；或者 `--work` / `XKJD_WORK` 指到有这些仓库的目录 |
| 部署日志里 `missing input schema: xkjd27_flow` | **正常**：`schema_list` 永远列全三个，`--only 27c` 时另外两个没文件。真要确认的是自己那个方案有没有产物：脚本会检查 prism/table，缺了会带着日志末尾退出 |
| `没有 rime_deployer` | `apt install librime-bin`（Arch：`pacman -S librime`） |
| `没有共享数据 /usr/share/rime-data/default.yaml` | `apt install librime-data`，或 `XKJD_SHARED=<你的 rime-data 目录>` |
| `python3 缺 lzma 模块` | 自编的 python 要 `--with-lzma`；Debian/Ubuntu 的 `python3` 自带 |
| `没有 emcc` / wasm 编译失败 | 只在重编 librime 时出现：装 emsdk 并 `source emsdk_env.sh`，或 `XKJD_EMSDK=<emsdk 目录>`。已有 `rime.js`/`rime.wasm` 时脚本会跳过编译 |
| 只改了 `api.cpp` 但网页没变 | `rime.wasm` 是旧链接的。`--rebuild-librime` 重编（脚本发现 `api.cpp` 比 `rime.wasm` 新会提醒你） |
| librime 编译缓存坏了 / 想从头编 | `rm -rf $XKJD_WORK/wasm`（或 `XKJD_WASM_ROOT` 指的目录），重跑 `build-all.sh --rebuild-librime`；缓存约 1.5 GB |
| 编译时报 `'boost/range/adaptor/reversed.hpp' file not found`、一 rebuild 就重头编 | **缓存被系统清了**。本机 `/etc/tmpfiles.d/tmp.conf` 是 `Q /tmp 1777 root root 1d`：`/tmp` 下 1 天没碰过的文件会被删，而 boost / lua 解包出来的源码 mtime 还是压缩包里的老时间 → 整个 boost 头文件树被删。旧缓存 `/tmp/rime_wasm` 就是这么烂的。默认缓存改成 `$XKJD_WORK/wasm`（脚本会在 `XKJD_WASM_ROOT` 落在 `/tmp` 下时提醒你）。**别用 `/tmp` 存编译缓存** |
| 干净缓存上第一次编，报 `cp: target '.../sysroot/include/opencc/': No such file or directory` | 旧 `build-librime.sh` 只会用缓存里已有的目录（2026-10-08 已修：加 `mkdir -p`），那时它只能在已有缓存上工作 |
| 打出来的 img 跟上次 md5 不一样 | 先看这次是不是拉了新提交（`build-all.sh` 会打印各仓库的短 hash）。方案/词库/lua 没变还变，就是复现性出问题了：确认 `SOURCE_DATE_EPOCH` 没被改，`rime_deployer`/librime 版本没变。注意 `layouts.js`/`sizes.js` 变了不算异常（体积/键位真变了） |
| 镜像文件数不对 / 候选出不来 | `user/build/*.prism.bin`、`*.table.bin` 缺了：方案仓库的 `rime/` 里那些 dict 是不是没提交全？看 `$XKJD_WORK/build/rime_deployer.log` |
| `git` 拉不动（离线 / 代理） | `--no-update` 用现有 checkout；脚本对 fetch 失败只是警告，不中断 |
| 工作目录下有未提交改动的方案仓库 | 脚本只警告、不更新（不会冲掉你的改动）；确认没问题再手动 `git pull` |
| 页面报「启动失败：拿不到数据镜像」 | img 没生成或路径不对：确认 `data/*.img` 存在，且服务是从网站仓库根起的（`base.img` 和方案 img 都要能 200） |
| 改了键位图 / 体积文案没生效 | `data/layouts.js`、`data/sizes.js` 是生成的：重跑 `export-data.sh`；还不行就是页面缓存，`?v=N` 或把 `index.html` 的 `BUILD` +1 |
| 想只重打一个方案但 `base.img` 也变了 | `--only` 会连 `base.img` 一起重打，但内容跟全量跑的一致（`schema_list` 固定列全三个）；md5 变说明你真的改了共享的东西（lua / 配置） |
| 站点上多传了 `tools/` | 正常：网站仓库根就是 docroot，所以 `tools/wasm-build/`（约 200 KB，含 vendor 的 LZMA SDK 源码）也会被发布。`data/` 之外的散文件（`<XKJD_WORK>/build/wasmdata`，34 MB）故意放在 docroot 外 |

---

## 相关文件

* `web/README.md` —— 网页侧怎么用这些 img（加载、IndexedDB 存用户数据、演示剧本）。
* `tools/README.md` —— 仓库外那堆研究/台架工具（探针、录音、同步实验）。
* `web/index.html` —— 站点主页；镜像/引擎的排查用控制台 `window.__ime`（见 `web/README.md`）。
* `lzma/README.md` —— vendor 进来的 LZMA SDK（public domain）出处。
