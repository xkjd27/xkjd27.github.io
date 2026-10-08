/* 数据装载：压缩镜像（LZMA2），一次请求拉一个。
 *
 *   const info = await loadRimeData(M, call, { asset, image:'data/27c.img', onProgress });
 *   // info = { mode:'image', image, files, bytes, ms }
 *
 * 镜像是 tools/wasm-build/pack-image.py 打的（`export-data.sh` 负责拆）：
 *   data/base.img      共享数据 + lua 引擎 + 配置（几十 KB，开机先挂它）
 *   data/<方案>.img    方案文件 + 预编译词库产物（prism/table，6~7 MB）
 * 几个镜像是**互补**的（文件名不重叠），可以先后挂到同一个内存文件系统里，
 * 所以切方案不用重新 init librime（认不出来时 ime.js 会重启一次引擎兼容）。
 *
 * 解压在 wasm 里做（rime_wasm_mount_begin/step/finish，见 tools/wasm-build/api.cpp）：
 * 先把镜像写进内存文件系统，再分片解开、每片之间让出主线程，进度条能实时走。
 */
const RIME_IMAGE = 'data/base.img';

/* 资产缓存穿透：页面 URL 上的 ?v=... 会给 rime.js / rime.wasm / 镜像都带上 */
const ASSET_V = new URLSearchParams(location.search).get('v') || '';
const asset = (u) => ASSET_V ? u + (u.includes('?') ? '&' : '?') + 'v=' + ASSET_V : u;
const loadScript = (src) => new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = src;
  s.onload = res;
  s.onerror = () => rej(new Error('加载失败 ' + src));
  document.head.appendChild(s);
});

async function loadRimeData(M, call, opts) {
  opts = opts || {};
  const asset = opts.asset || (u => u);
  const onProgress = opts.onProgress || (() => {});
  const image = opts.image || RIME_IMAGE;
  const t0 = performance.now();

  const r = await fetch(asset(image));
  if (!r.ok) throw new Error(`拿不到数据镜像 ${image}（HTTP ${r.status}）`);
  const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

  /* 流式下载（边读边报进度）：7 MB 的镜像在慢连接上是能看见走的 */
  const totalBytes = +(r.headers.get('Content-Length') || 0);
  let buf;
  if (r.body && r.body.getReader) {
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(totalBytes ? 0.5 * (got / totalBytes) : 0.5,
                 `下载 ${image}：${mb(got)}` + (totalBytes ? ' / ' + mb(totalBytes) : ''));
    }
    buf = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
  } else {
    buf = new Uint8Array(await r.arrayBuffer());
  }

  /* 先把镜像写进内存文件系统，再让 wasm 那边读它解压：
     这样 JS 不用碰 wasm 堆（HEAPU8 没导出也能用），装完就删掉。 */
  const imgPath = '/tmp/rime-data.img';
  M.FS.mkdirTree('/tmp');
  M.FS.writeFile(imgPath, buf);
  onProgress(0.5, `镜像 ${(buf.length / 1048576).toFixed(2)} MB（${image}），解压中…`);
  /* 解压分片跑（begin / step / finish）：每片之间 await 一下，
     浏览器才有机会重绘，进度条能动。 */
  const total = call('rime_wasm_mount_begin', 'number', ['string'], [imgPath]);
  if (total <= 0) throw new Error('数据镜像打不开（' + total + '）');
  const CHUNK = 256 * 1024;
  let got = 0, guard = 0;
  while (got < total && guard++ < 20000) {
    got = call('rime_wasm_mount_step', 'number', ['number'], [CHUNK]);
    if (got < 0) throw new Error('解压数据镜像失败（' + got + '）');
    onProgress(0.5 + 0.45 * (got / total),
               `解压 ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
    await new Promise(r => setTimeout(r, 0));   /* 让出主线程，重绘进度条 */
  }
  const files = call('rime_wasm_mount_finish', 'number', [], []);
  try { M.FS.unlink(imgPath); } catch (e) {}
  if (files <= 0) throw new Error('数据镜像里没有文件（' + files + '）');

  return { mode: 'image', image, files, bytes: buf.length,
           ms: Math.round(performance.now() - t0) };
}
