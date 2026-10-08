# LZMA SDK（vendor 进来的解码器）

来源：<https://www.7-zip.org/a/lzma2301.7z> 的 `C/` 目录，Igor Pavlov，**public domain**。

只留了解码要用的几个文件（`rime_wasm_mount()` 用它解 `web/wasmdata.img`）：

| 文件 | 作用 |
| --- | --- |
| `Lzma2Dec.c` / `.h` | LZMA2 流解码（分块、字典重置都在这里） |
| `LzmaDec.c` / `.h` | LZMA1 核心（区间解码 + 窗口），LZMA2 复用 |
| `7zTypes.h` `Alloc.h` `CpuArch.h` `Compiler.h` `Precomp.h` `7zWindows.h` | 上面两个的依赖头 |

注意：`Lzma2Dec_Allocate()` 期望的是 7-Zip 容器里那种「字典大小」属性字节（0~40），
我们用的是 xz 风格的 raw LZMA2 流，所以在 `api.cpp` 里自己拼了 5 字节的 LZMA1 属性
（`lc/lp/pb` 1 字节 + 字典大小 4 字节）再调 `LzmaDec_Allocate()`。
