#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 build/wasmdata/ 打成一个压缩镜像（web/data/base.img、web/data/<方案>.img）

镜像格式（与 tools/wasm-build/api.cpp 里的 rime_wasm_mount() 对应，小端）：

    0   char[8]  "XKJDRIMG"
    8   u32      version   = 1
    12  u32      payload   解压后的长度
    16  u32      packed    压缩流长度
    20  u32      dict      LZMA2 字典（解码窗口）
    24  u8       props     LZMA2 属性字节 (pb*5+lp)*9+lc
    25  u8[3]    pad
    28  ...      原始 LZMA2 流

解出来的「文件流」：u32 path_len | path | u32 size | data ... 然后一个 u32 0。

路径按内存文件系统里的绝对路径存（build/wasmdata/shared/x → /shared/x）。

用法（一般由 export-data.sh 调，别自己拼 include）：
    python3 tools/wasm-build/pack-image.py --src build/wasmdata --out web/data/27c.img \\
        --include 'user/xkjd27c_flow.*' --include 'user/build/xkjd27c_flow.*'
    python3 tools/wasm-build/pack-image.py --dict 16MiB ...   # 换字典大小（越大压缩率略好、解码内存越大）
    python3 tools/wasm-build/pack-image.py --help              # --include / --exclude / --dict
"""

import argparse
import lzma
import os
import struct
import sys

MAGIC = b'XKJDRIMG'
VERSION = 1
HEADER = 28

# LZMA2 属性字节：props = (pb * 5 + lp) * 9 + lc
LC, LP, PB = 3, 0, 2


def parse_size(text):
    text = str(text).strip()
    units = {'': 1, 'b': 1, 'k': 1 << 10, 'kb': 1 << 10, 'kib': 1 << 10,
             'm': 1 << 20, 'mb': 1 << 20, 'mib': 1 << 20,
             'g': 1 << 30, 'gb': 1 << 30, 'gib': 1 << 30}
    num = ''
    for ch in text:
        if ch.isdigit() or ch == '.':
            num += ch
        else:
            break
    unit = text[len(num):].strip().lower()
    if not num or unit not in units:
        raise argparse.ArgumentTypeError('看不懂的大小：%s' % text)
    return int(float(num) * units[unit])


def collect(root, excludes, includes=()):
    """→ [(fs_path, disk_path)]，按路径排序，保证可复现

    includes 非空时只留命中的文件（可把同一份目录拆成几个镜像）。
    """
    import fnmatch
    out = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            disk = os.path.join(dirpath, name)
            rel = os.path.relpath(disk, root).replace(os.sep, '/')
            if any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(name, pat)
                   for pat in excludes):
                continue
            if includes and not any(fnmatch.fnmatch(rel, pat) or
                                    fnmatch.fnmatch(name, pat)
                                    for pat in includes):
                continue
            out.append(('/' + rel, disk))
    out.sort()
    return out


def build_payload(files):
    parts = []
    total = 0
    for fs_path, disk in files:
        blob = open(disk, 'rb').read()
        path = fs_path.encode('utf-8')
        parts.append(struct.pack('<I', len(path)))
        parts.append(path)
        parts.append(struct.pack('<I', len(blob)))
        parts.append(blob)
        total += 4 + len(path) + 4 + len(blob)
    parts.append(struct.pack('<I', 0))
    total += 4
    return b''.join(parts), total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='导出目录（export-data.sh 的 build/wasmdata）')
    ap.add_argument('--out', required=True, help='写出的镜像路径（web/data/xxx.img）')
    ap.add_argument('--dict', type=parse_size, default=8 << 20,
                    help='LZMA2 字典大小（默认 8MiB；解码器会分配这么多内存）')
    ap.add_argument('--exclude', action='append', default=[],
                    help='排除的文件（glob，可多次给；默认排掉 *.reverse.bin）')
    ap.add_argument('--include', action='append', default=[],
                    help='只打这些（glob，可多次给；不给就是全打）')
    args = ap.parse_args()

    excludes = list(args.exclude)
    if not excludes:
        # flow 方案不读 reverse.bin（提示用单字表推导，见 flow_codes.lua），
        # 而它占了编译产物的一半以上，默认不打进镜像
        excludes = ['*.reverse.bin']

    files = collect(args.src, excludes, args.include)
    if not files:
        sys.exit('没有找到文件：%s（include=%s）' % (args.src, args.include))

    payload, payload_len = build_payload(files)
    filters = [{'id': lzma.FILTER_LZMA2, 'preset': 9 | lzma.PRESET_EXTREME,
                'dict_size': args.dict}]
    packed = lzma.compress(payload, format=lzma.FORMAT_RAW, filters=filters)
    props = (PB * 5 + LP) * 9 + LC

    header = MAGIC + struct.pack('<IIII', VERSION, payload_len, len(packed),
                                 args.dict) + bytes([props]) + b'\x00\x00\x00'
    assert len(header) == HEADER, len(header)
    with open(args.out, 'wb') as fh:
        fh.write(header)
        fh.write(packed)

    raw = sum(os.path.getsize(d) for _, d in files)
    print('文件 %d 个' % len(files))
    print('原始      %10.2f MB' % (raw / 1048576))
    print('解压后     %10.2f MB' % (payload_len / 1048576))
    print('镜像       %10.2f MB  （%.1f%% of 原始，字典 %d MiB）'
          % ((HEADER + len(packed)) / 1048576,
             100.0 * (HEADER + len(packed)) / raw, args.dict >> 20))
    print('写出       %s' % args.out)


if __name__ == '__main__':
    main()
