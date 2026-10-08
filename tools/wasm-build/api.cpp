/*
 * api.cpp —— 浏览器里跑的 librime（wasm）最小接口
 *
 * 只做一件事：把「按键 → 上下文/候选/上屏」暴露给 JS。
 * 文件都放在 Emscripten 的内存文件系统里（JS 用 FS.writeFile 写进去）：
 *   /shared/default.yaml            librime 的最小共享数据
 *   /user/<schema>.schema.yaml      方案（含 flow_engine 的 sound_keys / shape_keys）
 *   /user/<schema>.shape.txt        方案自带的形码表
 *   /user/<schema>.danzi.dict.yaml  方案自带的单字读音权重
 *   /user/<schema>.shape.dict.yaml  方案自带的部件形码（候选提示用）
 *   /user/<schema>.secondary.yaml   方案自带的次简表
 *   /user/lua/                      方案脚本（.lua）
 *   /user/build/                    预编译好的 prism/table + 部署副本
 *   /user/default.custom.yaml       schema_list（部署期的 patch，运行时不读）
 */
#include <emscripten.h>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include "lzma/Lzma2Dec.h"

#include "rime_api.h"

/* boost::interprocess 会引用 System V 共享内存的符号；wasm 里没有，
   但我们的方案只用文件映射（mmap），所以给个不会走到的桩即可 */
extern "C" {
int shmdt(const void*) { return -1; }
int shmat(int, const void*, int) { return -1; }
int shmget(int, unsigned long, int) { return -1; }
}

/* lua 插件的对象只靠静态初始化注册，链接器会把没人引用的对象丢掉，
   这里引一下它的 module 入口，保证插件被链进来 */
void rime_require_module_lua();  /* C++ 链接（宏生成的符号是 mangled 的） */

static RimeApi* g_api = nullptr;
static RimeSessionId g_session = 0;
static std::string g_user_dir;

static std::string g_out;

static void json_escape(std::string& out, const char* s) {
  if (!s) {
    out += "null";
    return;
  }
  out += '"';
  for (const unsigned char* p = (const unsigned char*)s; *p; ++p) {
    switch (*p) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (*p < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", *p);
          out += buf;
        } else {
          out += (char)*p;
        }
    }
  }
  out += '"';
}

extern "C" {

/* 初始化引擎（不跑部署：词库产物是预先编译好的） */
EMSCRIPTEN_KEEPALIVE
int rime_wasm_init(const char* shared_dir, const char* user_dir) {
  if (g_api)
    return 0;
  rime_require_module_lua();
  g_api = rime_get_api();
  if (!g_api)
    return -1;

  RimeTraits traits;
  memset(&traits, 0, sizeof(traits));
  RIME_STRUCT_INIT(RimeTraits, traits);
  traits.shared_data_dir = shared_dir;
  traits.user_data_dir = user_dir;
  traits.distribution_name = "Rime";
  traits.distribution_code_name = "rime_wasm";
  traits.distribution_version = "1.13.1";
  traits.app_name = "rime.wasm";
  traits.log_dir = user_dir;

  g_user_dir = user_dir ? user_dir : "";

  g_api->setup(&traits);
  g_api->initialize(&traits);
  return 0;
}

/* 选方案，返回 1 成功 */
EMSCRIPTEN_KEEPALIVE
int rime_wasm_select(const char* schema_id) {
  if (!g_api)
    return 0;
  if (g_session)
    g_api->destroy_session(g_session);
  g_session = g_api->create_session();
  if (!g_session)
    return 0;
  return g_api->select_schema(g_session, schema_id) ? 1 : 0;
}

/* 按键。keycode 用 Rime 的约定（可打印字符就是 ASCII） */
EMSCRIPTEN_KEEPALIVE
int rime_wasm_key(int keycode, int mask) {
  if (!g_api || !g_session)
    return 0;
  return g_api->process_key(g_session, keycode, mask) ? 1 : 0;
}

/* 清空当前输入 */
EMSCRIPTEN_KEEPALIVE
void rime_wasm_clear(void) {
  if (g_api && g_session)
    g_api->clear_composition(g_session);
}

/* 现在输入串里的编码 */
EMSCRIPTEN_KEEPALIVE
const char* rime_wasm_input(void) {
  g_out.clear();
  if (!g_api || !g_session)
    return g_out.c_str();
  const char* s = g_api->get_input(g_session);
  g_out = s ? s : "";
  return g_out.c_str();
}

/* 上屏文本（取一次就没了），没有则返回空串 */
EMSCRIPTEN_KEEPALIVE
const char* rime_wasm_commit(void) {
  g_out.clear();
  if (!g_api || !g_session)
    return g_out.c_str();
  RimeCommit commit;
  memset(&commit, 0, sizeof(commit));
  if (g_api->get_commit(g_session, &commit)) {
    g_out = commit.text ? commit.text : "";
    g_api->free_commit(&commit);
  }
  return g_out.c_str();
}

/*
 * 当前状态：{"input":"wumk","preedit":"wumk",
 *            "candidates":[{"text":"我们","comment":""}, ...]}
 */
EMSCRIPTEN_KEEPALIVE
const char* rime_wasm_state(void) {
  g_out.clear();
  if (!g_api || !g_session) {
    g_out = "{}";
    return g_out.c_str();
  }

  const char* input = g_api->get_input(g_session);
  g_out = "{\"input\":";
  json_escape(g_out, input ? input : "");

  g_out += ",\"preedit\":";
  RimeContext ctx;
  memset(&ctx, 0, sizeof(ctx));
  RIME_STRUCT_INIT(RimeContext, ctx);
  Bool has_ctx = g_api->get_context(g_session, &ctx);
  if (has_ctx) {
    json_escape(g_out, ctx.composition.preedit ? ctx.composition.preedit : "");
  } else {
    json_escape(g_out, input ? input : "");
  }

  /* 候选只给**当前这一页**（menu.candidates 就是当前页，最多 page_size 个）。
     以前给的是整张表，网页显示第一页、数字键却按引擎那一页选 —— 翻页就对不上了。 */
  g_out += ",\"candidates\":[";
  int page_no = 0, page_size = 5, num = 0;
  Bool last = 1;
  if (has_ctx) {
    page_no = ctx.menu.page_no;
    page_size = ctx.menu.page_size ? ctx.menu.page_size : 5;
    last = ctx.menu.is_last_page;
    num = ctx.menu.num_candidates;
    for (int i = 0; i < num; i++) {
      if (i) g_out += ",";
      g_out += "{\"text\":";
      json_escape(g_out, ctx.menu.candidates[i].text);
      g_out += ",\"comment\":";
      json_escape(g_out, ctx.menu.candidates[i].comment);
      g_out += "}";
    }
  }
  char tail[96];
  snprintf(tail, sizeof(tail), "],\"page\":%d,\"pageSize\":%d,\"lastPage\":%s}",
           page_no, page_size, last ? "true" : "false");
  g_out += tail;
  if (has_ctx) g_api->free_context(&ctx);
  return g_out.c_str();
}

/*
 * 用户数据复位：把用户目录里的用户数据删掉，回到「没打过字」的状态。
 *
 * 用户数据只有两处：
 *   <user>/<name>.userdb/     Rime 原生 userdb（leveldb 目录：排码 / 次简 / 造词记录）
 *   <user>/<name>.order.txt   flow_order 的 txt 后端（如果配置成 txt）
 * 方案文件、build/ 下的产物是方案自带的数据，不能动。
 *
 * 顺序很重要：先销毁会话（filter / processor 析构 → order.close()
 * 把 leveldb 关掉、数据落盘），再删目录；反过来删了还在写的库，
 * close() 时 leveldb 会把 MANIFEST / CURRENT 又写回来。
 */
static bool rm_rf(const std::string& path) {
  struct stat st;
  if (lstat(path.c_str(), &st) != 0)
    return false;
  if (!S_ISDIR(st.st_mode))
    return unlink(path.c_str()) == 0;
  DIR* d = opendir(path.c_str());
  if (d) {
    struct dirent* e;
    while ((e = readdir(d))) {
      std::string name = e->d_name;
      if (name == "." || name == "..")
        continue;
      rm_rf(path + "/" + name);
    }
    closedir(d);
  }
  return rmdir(path.c_str()) == 0;
}

static bool has_suffix(const std::string& s, const char* suffix) {
  size_t n = strlen(suffix);
  return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}

/* 删掉的条目数；调用方随后用 rime_wasm_select 重建会话。
 *
 * schema_id 非空时只删这个方案的（<schema_id>.userdb / <schema_id>.order.txt /
 * <schema_id>.userdb.txt）—— 三个方案装同一个用户目录时（网页里的镜像就是），
 * 清演示数据不能把用户在别的方案里打过的字一起抹了。
 * schema_id 为 NULL / 空串 = 全删（老行为）。
 */
static int reset_user_impl(const char* schema_id) {
  if (!g_api)
    return -1;
  if (g_session) {
    g_api->destroy_session(g_session);
    g_session = 0;
  }
  if (g_user_dir.empty())
    return 0;

  const std::string prefix =
      (schema_id && *schema_id) ? std::string(schema_id) + "." : std::string();

  std::vector<std::string> victims;
  DIR* d = opendir(g_user_dir.c_str());
  if (d) {
    struct dirent* e;
    while ((e = readdir(d))) {
      std::string name = e->d_name;
      if (name == "." || name == "..")
        continue;
      if (!prefix.empty() && name.compare(0, prefix.size(), prefix) != 0)
        continue;
      if (has_suffix(name, ".userdb") || has_suffix(name, ".order.txt") ||
          has_suffix(name, ".userdb.txt"))
        victims.push_back(g_user_dir + "/" + name);
    }
    closedir(d);
  }
  for (size_t i = 0; i < victims.size(); ++i)
    rm_rf(victims[i]);
  return (int)victims.size();
}

EMSCRIPTEN_KEEPALIVE
int rime_wasm_reset_user(void) { return reset_user_impl(nullptr); }

EMSCRIPTEN_KEEPALIVE
int rime_wasm_reset_user_of(const char* schema_id) {
  return reset_user_impl(schema_id);
}

/* 关掉引擎（会话 + librime），之后可以再 rime_wasm_init 一次。
 *
 * 网页里三个方案的数据是分几个镜像挂的：先挂 base + 当前方案，点另一个 tab 再挂
 * 它那份。方案文件是在 initialize 之后才出现的，librime 认不认是它自己的事；
 * 不认就 shutdown → 挂完新镜像 → init 重来一遍。
 */
EMSCRIPTEN_KEEPALIVE
void rime_wasm_shutdown(void) {
  if (!g_api)
    return;
  if (g_session) {
    g_api->destroy_session(g_session);
    g_session = 0;
  }
  g_api->finalize();
  g_api = nullptr;
}

/* ------------------------------------------------------------------
 * 压缩镜像：一个文件装下整套方案 + 词库产物
 *
 * 格式（小端；打包脚本：tools/wasm-build/pack-image.py）
 *   0   char[8]  "XKJDRIMG"
 *   8   u32      version   = 1
 *   12  u32      payload   解压后的长度
 *   16  u32      packed    压缩流长度
 *   20  u32      dict      LZMA2 字典（解码窗口）
 *   24  u8       props     LZMA2 属性字节 (pb*5+lp)*9+lc
 *   25  u8[3]    pad
 *   28  ...      原始 LZMA2 流（解出来是下面的「文件流」）
 *
 * 文件流：
 *   u32 path_len | path | u32 size | data ... 然后一个 u32 0 收尾
 *
 * 解压用 LZMA SDK 的 Lzma2Dec（public domain，两个 .c 就够，
 * 比 zstd/brotli 的解码器小得多，而压缩率是这几个里最好的）。
 * 整包解到内存再展开：15 MB 量级，wasm 堆完全吃得下。
 * ------------------------------------------------------------------ */

static void* sz_alloc(ISzAllocPtr p, size_t size) {
  (void)p;
  return malloc(size);
}
static void sz_free(ISzAllocPtr p, void* addr) {
  (void)p;
  free(addr);
}
static const ISzAlloc g_alloc = {sz_alloc, sz_free};

/* 建出文件所在目录（只建父目录，别把文件名也建成目录） */
static void mkdir_p(const std::string& file_path) {
  size_t slash = file_path.rfind('/');
  if (slash == std::string::npos || slash == 0)
    return;
  const std::string dir = file_path.substr(0, slash);
  for (size_t i = 1; i <= dir.size(); ++i) {
    if (i != dir.size() && dir[i] != '/')
      continue;
    std::string sub = dir.substr(0, i);
    if (sub == "/" || sub.empty())
      continue;
    mkdir(sub.c_str(), 0777);  /* 已存在就算了 */
  }
}

static void mount_log(const char* fmt, ...) {
  FILE* f = fopen("/tmp/rime-mount.log", "a");
  if (!f)
    return;
  va_list ap;
  va_start(ap, fmt);
  vfprintf(f, fmt, ap);
  va_end(ap);
  fputc('\n', f);
  fclose(f);
}

static uint32_t rd_u32(const unsigned char* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}

/* ---------------- 挂载：begin / step / finish ----------------
   分三步是为了让前端能一边解压一边刷进度条：
     begin(path)  → 读镜像、解析头、分配缓冲，返回解压后长度（<0 错误）
     step(budget) → 最多再解 budget 字节输入，返回「已解出的字节数」
                    （budget<=0 表示一次解完；<0 是错误）
     finish()     → 把解出来的文件流展开进内存文件系统，返回文件数
   每步之间 JS 可以 await 一下，浏览器就有机会重绘。 */

static struct {
  unsigned char* in;
  unsigned char* out;
  uint32_t packed;
  uint32_t payload;
  uint32_t in_pos;
  uint32_t out_pos;
  CLzma2Dec dec;
  bool active;
} g_mount = {nullptr, nullptr, 0, 0, 0, 0, {}, false};

static void mount_release() {
  if (g_mount.active)
    Lzma2Dec_Free(&g_mount.dec, &g_alloc);
  free(g_mount.in);
  free(g_mount.out);
  g_mount.in = nullptr;
  g_mount.out = nullptr;
  g_mount.active = false;
  g_mount.in_pos = g_mount.out_pos = 0;
}

static int unpack_payload(const unsigned char* out, uint32_t payload) {
  int count = 0;
  size_t p = 0;
  while (p + 4 <= payload) {
    uint32_t path_len = rd_u32(out + p);
    p += 4;
    if (path_len == 0)
      break;  /* 收尾 */
    if (p + path_len + 4 > payload)
      break;
    std::string path((const char*)out + p, path_len);
    p += path_len;
    uint32_t size = rd_u32(out + p);
    p += 4;
    if (p + size > payload)
      break;
    mkdir_p(path);
    FILE* f = fopen(path.c_str(), "wb");
    if (f) {
      if (size)
        fwrite(out + p, 1, size, f);
      fclose(f);
      ++count;
    }
    p += size;
  }
  return count;
}

EMSCRIPTEN_KEEPALIVE
int rime_wasm_mount_begin(const char* path) {
  mount_release();
  if (!path)
    return -1;
  FILE* f = fopen(path, "rb");
  if (!f)
    return -2;
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (len < 28) {
    fclose(f);
    return -3;
  }
  g_mount.in = (unsigned char*)malloc((size_t)len);
  if (!g_mount.in) {
    fclose(f);
    return -4;
  }
  size_t got = fread(g_mount.in, 1, (size_t)len, f);
  fclose(f);
  if (got != (size_t)len) {
    mount_release();
    return -5;
  }

  const unsigned char* img = g_mount.in;
  if (memcmp(img, "XKJDRIMG", 8) != 0 || rd_u32(img + 8) != 1) {
    mount_release();
    return -6;
  }
  g_mount.payload = rd_u32(img + 12);
  g_mount.packed = rd_u32(img + 16);
  uint32_t dict = rd_u32(img + 20);
  unsigned char props = img[24];
  if (g_mount.payload == 0 || 28 + (size_t)g_mount.packed > (size_t)len) {
    mount_release();
    return -7;
  }

  g_mount.out = (unsigned char*)malloc(g_mount.payload);
  if (!g_mount.out) {
    mount_release();
    return -8;
  }

  /* Lzma2Dec_Allocate() 收的是 7-Zip 那套「字典大小」属性字节；
     我们是 xz 风格的 raw LZMA2 流，自己拼 LZMA1 的 5 字节属性再分配。 */
  Byte props5[LZMA_PROPS_SIZE];
  props5[0] = props;
  props5[1] = (Byte)(dict & 0xFF);
  props5[2] = (Byte)((dict >> 8) & 0xFF);
  props5[3] = (Byte)((dict >> 16) & 0xFF);
  props5[4] = (Byte)((dict >> 24) & 0xFF);
  Lzma2Dec_Construct(&g_mount.dec);
  if (LzmaDec_Allocate(&g_mount.dec.decoder, props5, LZMA_PROPS_SIZE,
                       &g_alloc) != SZ_OK) {
    mount_release();
    return -9;
  }
  Lzma2Dec_Init(&g_mount.dec);
  g_mount.in_pos = 28;   /* 压缩流从第 28 字节开始 */
  g_mount.out_pos = 0;
  g_mount.active = true;
  mount_log("begin len=%d payload=%u packed=%u dict=%u props=%u", (int)len,
            g_mount.payload, g_mount.packed, dict, props);
  return (int)g_mount.payload;
}

/* 返回已解出的总字节数；<0 错误 */
EMSCRIPTEN_KEEPALIVE
int rime_wasm_mount_step(int budget) {
  if (!g_mount.active)
    return -1;
  while (g_mount.out_pos < g_mount.payload && g_mount.in_pos < 28 + g_mount.packed) {
    SizeT in_len = 28 + g_mount.packed - g_mount.in_pos;
    SizeT out_len = g_mount.payload - g_mount.out_pos;
    if (budget > 0 && in_len > (SizeT)budget)
      in_len = (SizeT)budget;
    SizeT in_used = in_len, out_used = out_len;
    ELzmaStatus status;
    SRes res = Lzma2Dec_DecodeToBuf(&g_mount.dec, g_mount.out + g_mount.out_pos,
                                    &out_used, g_mount.in + g_mount.in_pos,
                                    &in_used, LZMA_FINISH_ANY, &status);
    if (res != SZ_OK)
      return -2;
    g_mount.in_pos += (uint32_t)in_used;
    g_mount.out_pos += (uint32_t)out_used;
    if (in_used == 0 && out_used == 0)
      break;  /* 不该发生，防死循环 */
    if (budget > 0)
      break;  /* 这一片够了，回去刷进度条 */
  }
  return (int)g_mount.out_pos;
}

EMSCRIPTEN_KEEPALIVE
int rime_wasm_mount_finish() {
  if (!g_mount.active)
    return -1;
  if (g_mount.out_pos != g_mount.payload)
    return -2;  /* 还没解完 */
  int n = unpack_payload(g_mount.out, g_mount.payload);
  mount_log("unpacked %d files", n);
  mount_release();
  return n;
}

/* 一次跑完（不分片），等价于 begin + step(0) + finish */
EMSCRIPTEN_KEEPALIVE
int rime_wasm_mount_file(const char* path) {
  int total = rime_wasm_mount_begin(path);
  if (total < 0)
    return total;
  int got = rime_wasm_mount_step(0);
  if (got != total) {
    mount_release();
    return -10;
  }
  return rime_wasm_mount_finish();
}

/* librime 的 wasm 补丁（build-librime.sh 补丁 4）会调它报部署进度；
   浏览器里不再做在线部署，留个空实现只为链接得过。 */
extern "C" void rime_deploy_progress(const char* phase, long long done, long long total) {}

/* 列出可选的方案（读的是部署副本 default.yaml 里的 schema_list） */
EMSCRIPTEN_KEEPALIVE
const char* rime_wasm_schema_list(void) {
  g_out.clear();
  if (!g_api) {
    g_out = "[]";
    return g_out.c_str();
  }
  RimeSchemaList list;
  memset(&list, 0, sizeof(list));
  g_out = "[";
  if (g_api->get_schema_list(&list)) {
    for (size_t i = 0; i < list.size; ++i) {
      if (i) g_out += ",";
      g_out += "{\"id\":";
      json_escape(g_out, list.list[i].schema_id);
      g_out += ",\"name\":";
      json_escape(g_out, list.list[i].name);
      g_out += "}";
    }
    g_api->free_schema_list(&list);
  }
  g_out += "]";
  return g_out.c_str();
}

}  // extern "C"
