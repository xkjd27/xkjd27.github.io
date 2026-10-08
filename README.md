# 函流输入方案 · 网页（主页 + 真 librime 预览框）

`web/` 是「函流输入方案」的主页：三个方案（键道・函流 / 贰柒・函流 / 贰柒C・函流）
一个 tab 一个，键位图是 HTML/CSS 画的，下面那台输入法**是真的**——librime 1.13 +
lua 插件编译成 WebAssembly，候选、提示键、顶功、排码、造词全是它现算的。

打开：`cd web && python3 -m http.server 3444 --bind 0.0.0.0`，然后 <http://主机:3444/>。
（纯静态，扔到任何 static hosting 上都能跑；没有后端。）

## 页面是怎么搭的

| 区块 | 内容 |
| --- | --- |
| 大标题 + tab | 点 tab 换方案：键位图、说明文字、下面那台输入法一起换 |
| 键位 | `data/layouts.js` 渲染的 HTML/CSS 键盘（与 `docs/layout.png` 同一份计算） |
| 打给你看 | librime wasm 预览框：▶ 演示（自动循环放剧情）/ ⌨ 体验（自己打字） |
| 了解详情 | 双形 / 顶功 / 排码 / 造词 四张卡片 |

预览框里按的键会**点亮上面的键位图**（体验模式直接按物理键盘也一样），
所以边看演示边对键位是对的。

## 数据：一个 base + 每个方案一个镜像

```
web/data/base.img      共享数据 + lua 引擎 + 配置（约 30 KB，进页面就挂）
web/data/keytao.img    键道・函流：方案文件 + 词库产物（1.1 MB）
web/data/27.img        贰柒・函流（7.0 MB）
web/data/27c.img       贰柒C・函流（7.0 MB）
web/data/layouts.js    键位表（键位图 + 体验模式的「哪些键交给引擎」都靠它）+ 共用的纯形码表
web/data/demos.js      三套演示的按键序列（录音脚本生成，见下）
web/data/sizes.js      各镜像体积（页面上那句「首次点开要下 7.0 MB」）
```

* `layouts.js` 里三套方案的**笔码是同一份**（`FLOW_SHAPES`，码用笔形 乛 丨 丶 丿 ㇐ 写，
  键位图每个笔形键下面就摆这份），各方案只记自己笔形键的**落键**（`shapeMap`）——
  改笔码只改一处；27C 的 丿 落在 `e` 上，渲染时自动把码里的 丿 换成 `e`。

* 页面本身**不阻塞**：tab、键位图、卡片都是静态渲染的，只有预览框走进度条。
* 镜像**按需下载**：点哪个 tab 才拉哪个方案；拉完 `rime_wasm_shutdown()` +
  `rime_wasm_init()` 重启一次引擎再 `select_schema`（方案文件是 initialize 之后
  才挂上的，重来一遍最稳）。换回已经拉过的方案是瞬间的（文件已在内存里）。
* 三个方案装在**同一个用户目录**里（跟真实用户装三个方案一样）。引擎是按
  schema 缓存的，互不污染——这条有专门的台架验证，见 `tools/flow_engine_test.md`。

## 体验模式：一块真的 textarea

已上屏的文字就是 `<textarea>` 的 value，所以光标、选区、复制粘贴、退格删除、
撤销、方向键**全是浏览器原生行为**；组字（preedit）是一层绝对定位的浮层，
画在组字开始的位置，带音码 / 形码配色，不干扰原生编辑。

只有引擎真正要听的键才 `preventDefault` 后交给 librime（键位表来自
`data/layouts.js` 的 `soundKeys` / `shapeKeys`）：

| 键 | 行为 |
| --- | --- |
| 声母键 / 笔形键 | 交给引擎（起组字、补形码） |
| 组字中的 空格 / Tab / 数字 1-9 / `-` / `=` / 退格 / 回车 / Esc | 交给引擎 |
| `` ` `` | 交给引擎（进造词） |
| `,` `.` `;` `:` `!` `?` | 先问引擎（Rime 的 punct 表会把 `,` 变成 `，`）；引擎不理就照原样打进去 |
| 其余（方向键、Delete、粘贴、`Ctrl/Cmd` 组合、Shift+字母打英文……） | 完全交给 textarea |

### 用户数据按方案分开存

排码 / 造词 / 次简记录都在 `<user>/<方案>.userdb/` 里，浏览器侧存进 IndexedDB：

* 库 `flow-ime-web`，表 `kv`，**key = `userdb:<schema_id>`**（三个方案三份）
* 存的是整目录快照（打过字 1.2 秒防抖，关页/切后台再存一次）
* 演示每轮只清**当前方案**那份（`rime_wasm_reset_user_of(schema_id)`），
  不会把你在别的方案里打过的字一起抹掉
* 浏览器存储打不开时降级成「只留在内存里」，不会把页面卡住

## 演示剧本是「录」出来的

`data/demos.js` 不是手写的：仓库外的 `../tools/record_demo.py` 用原生 librime
（`tools/flow_engine_probe.c` 的 `--repl` 模式）把整场戏喂一遍，词库、权重、
lua 任一改动重录一次即可：

```sh
python3 ../tools/record_demo.py                 # 三个方案，写 web/data/demos.js
python3 ../tools/record_demo.py --schemes 27c -v
```

录音脚本干的事：从方案词库读每个词的方案码 → 敲码 → 如果候选里目标词不在首选，
就按**引擎给的提示键**（候选 comment）把它顶上来 → 记录按键。录完还会逐段核对
上屏文字（① 整句、③ 调频、⑤ 造词、⑦ 再打一遍），对不上就直接报错。

剧情（每轮自动复位用户数据，从「没打过字」开始）：

| 阶段 | 演什么 |
| --- | --- |
| ① 整句输入 | 「似水流年，往事如烟，他说泥菩萨过江自身难保。」——低权重词要按提示键才上位 |
| ② 退格 | 删掉整句 |
| ③ 调频 | 打「似水 / 流年」，按 <kbd>-</kbd> 固定到最短一级 |
| ⑤ 造词 | <kbd>`</kbd> 起造词，两段拼出「泥菩萨过江自身难保」，<kbd>-</kbd> 入库再调到最高 |
| ⑦ 再打一遍 | 两处都成了「一个码 + 顶功」，整句一路顶下去 |

节奏只有一个旋钮：`web/index.html` 顶部的 `SPEED`（默认 0.5），或 URL 上
`?speed=0.25`。

## 重新生成

```sh
# 一条命令：拉/更新三个方案仓库 → （需要时）编 wasm → 部署 → 重打四个 img + 键位表
cd <网站仓库根> && bash tools/wasm-build/build-all.sh
```

细分的话（都等价于上面一条命令的一部分，细节与依赖见 `tools/wasm-build/README.md`）：

```sh
# 1) 编 wasm（只在改了 api.cpp / 升级 librime 时需要；build-all.sh 会自己跳过）
bash tools/wasm-build/build-librime.sh
# 2) 部署三个方案 → 拆成 data/base.img + 每个方案一个 img + layouts.js/sizes.js
bash tools/wasm-build/export-data.sh            # 只要其中几个：export-data.sh 27c keytao
# 3) 重录演示（词库 / 权重 / lua 变了；脚本在仓库外的 tools/record_demo.py）
python3 ../tools/record_demo.py
```

中间产物（散文件，约 34 MB）在**网站仓库上一级**的 `build/wasmdata/`（`XKJD_WORK`
可换），**不在 `web/` 里**：`web/` 是 docroot，部署时整份上传，浏览器只读 `data/*.img`。

资产带缓存穿透：`/?v=3` 会给 `rime.js` / `rime.wasm` / `data/*.img` / 页面自己的
`*.js` 都带上 `?v=3`，改完刷新页面时记得加上。

## 控制台调试

原来的探针页（`_probe.html` / `_test_wasm.html` / `_debug_mount.html`）已删：预览实例就挂在
`window.__ime` 上，滚到「试打」区等它就绪（`window.__ready === true` 表示 base + 当前方案的
镜像挂好、引擎能出候选），控制台里能看的东西和探针页一样：

```js
__ime.current                          // 当前方案：keytao / 27 / 27c
__ime.useScheme('27c')                 // 等价于点第三个 tab（异步，等它跑完）
__ime.feed('n')                        // 喂一个键，返回 { commit, st }
__ime.stateNow()                       // { input, preedit, candidates, page, pageSize, ... }
__ime.call('rime_wasm_schema_list', 'string', [], [])   // 镜像里有哪些方案
__ime.M.FS.readdir('/user')            // 挂进内存文件系统的文件
__ime.M.FS.readFile('/tmp/rime-mount.log', { encoding: 'utf8' })   // wasm 侧挂载日志
```
