/* ============================================================================
 * 函流输入法 · 网页里的 librime 预览框
 *
 * 一个页面里跑**一个** librime wasm 实例，三个方案装在同一个用户目录里
 * （跟真实用户把三个方案都装上一样；引擎按 schema 缓存，互不污染，见
 * tools/flow_engine_test.md）。数据分几个镜像挂：
 *
 *   data/base.img     共享数据 + lua 引擎 + 配置（几十 KB，开机就挂）
 *   data/<方案>.img   方案文件 + 词库产物（点它的 tab 才拉，拉完重启一次引擎）
 *
 * 体验模式用的是一块**真的 <textarea>**：
 *
 *   已上屏的文字就是 textarea 的 value —— 光标、选区、复制粘贴、退格删除、
 *   撤销、上下左右全都是浏览器原生行为；
 *   组字（preedit）是一层绝对定位的浮层，画在 textarea 里组字开始的那个位置，
 *   带音码 / 形码配色，所以既不干扰原生编辑，也还看得见「音 + 形」。
 *
 *   只有引擎真正要听的键才 preventDefault 后交给 librime：方案的声母键 / 笔形键、
 *   组字中的空格、Tab、数字、-、=、退格；其余（标点、粘贴、方向键、Delete、
 *   Shift+字母打英文……）一律放给 textarea 自己处理。
 *
 * 用户数据（排码 / 造词 / 次简记录）按**方案**分开存在 IndexedDB
 * （key = 'userdb:<schema_id>'），演示每轮只清当前方案那份，不会串方案。
 * ========================================================================== */
'use strict';

const PACE = {
  normal: 460, slow: 1150, hit: 340, promote: 520, commit: 700,
  title: 660, gap: 840, reset: 900, eraseKey: 120, eraseChar: 110, end: 1200,
};

const KEYCODE = { space: 0x20, Tab: 0xff09, Enter: 0xff0d, Esc: 0xff1b, BackSpace: 0xff08 };
const USER_DATA_RE = /\.userdb$|\.(order|userdb)\.txt$/;
/* 右下角浮层只报排码键（空格上屏不报，音码笔码靠键位图高亮） */
const HUD_KEYS = ['-', '='];
const DEBUG = new URLSearchParams(location.search).has('debug');

class ImePreview {
  constructor(root, opts) {
    opts = opts || {};
    this.root = root;
    this.schemes = opts.schemes || {};
    this.order = opts.order || Object.keys(this.schemes);
    this.demos = opts.demos || {};
    this.layouts = opts.layouts || {};
    this.onKey = opts.onKey || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onPhase = opts.onPhase || (() => {});
    this.onProgress = opts.onProgress || (() => {});
    this.speed = opts.speed || 0.5;

    this.M = null;
    this.call = null;
    this.ready = false;
    this.current = null;
    this.pendingScheme = null;
    this.loaded = new Set();
    this.mode = 'demo';
    this.token = 0;
    this.round = 0;
    this.lastCands = [];
    this.saveTimer = null;
    this.lock = null;
    this.playing = false;      /* 演示循环是否在跑（同一时刻只允许一个） */
    this.visible = true;       /* 预览框是否在视口里 —— 滚走就暂停并复位 */
    this.composing = false;
    this.compAnchor = 0;      /* 组字开始的字符位置（浮层画这儿） */
    this.inserting = false;
    this.docValue = '';
    this.lastState = { input: '', preedit: '' };
    this.mirror = null;

    this.el = {
      doc: root.querySelector('.ime-doc'),
      ta: root.querySelector('.ime-ta'),
      ov: root.querySelector('.ime-ov'),
      cands: root.querySelector('.ime-cands'),
      phase: root.querySelector('.ime-phase'),
      live: root.querySelector('.ime-live'),
      tip: root.querySelector('.ime-tipline'),
      cap: root.querySelector('.ime-cap'),
      capLbl: root.querySelector('.ime-caplbl'),
      hud: root.querySelector('.ime-hud'),
    };

    /* textarea：已上屏文字的载体。原生行为都要留着，只在下面这些时刻回调。 */
    const ta = this.el.ta;
    ta.addEventListener('input', (e) => {
      if (this.inserting) { this.docValue = ta.value; return; }
      /* 组字期间，方案键字符只该出现在浮层里。有些环境（系统输入法 / 浏览器差异）
         会把它们也插进 textarea —— 那就撤掉，免得和浮层叠成重影。 */
      if (this.composing && e && e.data && /^[\x20-\x7e]+$/.test(e.data) &&
          [...e.data].every((c) => this.isSchemeKey(c))) {
        this.inserting = true;
        ta.value = this.docValue;
        const at = Math.min(this.compAnchor == null ? ta.value.length : this.compAnchor, ta.value.length);
        ta.selectionStart = ta.selectionEnd = at;
        this.inserting = false;
        this.renderOverlay();
        this.placeCands();
        return;
      }
      this.docValue = ta.value;
      /* 用户自己改文字（粘贴/剪切/撤销/Delete）时，组字锚点会失效 —— 清掉组字 */
      if (this.composing) this.clearComposition();
      this.placeCands();
    });
    ta.addEventListener('scroll', () => { this.renderOverlay(); this.placeCands(); });
    ta.addEventListener('click', () => {
      /* 只用来定位光标 / 收起组字；换模式一律走上面那两个按钮 */
      if (this.mode !== 'free') return;
      if (this.composing) this.clearComposition();
      this.placeCands();
    });
    ta.addEventListener('focus', () => { if (this.composing) this.renderOverlay(); });

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('resize', () => { this.renderOverlay(); this.placeCands(); });
  }

  /* ---------------------------------------------------------------- 引擎 */
  get schemaId() { return this.schemes[this.current].id; }

  /** 小队列：挂镜像 / 切方案 / 换模式都串起来（演示循环还在跑时尤其要紧） */
  locked(fn) {
    const prev = this.lock || Promise.resolve();
    let release;
    this.lock = new Promise((r) => { release = r; });
    this.busy = (this.busy || 0) + 1;
    const done = prev.then(fn).finally(() => {
      this.busy = Math.max(0, (this.busy || 1) - 1);
      release();
    });
    /* 看门狗：某个环节真卡死了（比如浏览器存储无响应）时，别把后面所有操作一起拖住 */
    return Promise.race([
      done,
      this.sleep(60000).then(() => {
        console.warn('[ime] 这一步超过 60 秒还没完，先放开队列');
        release();
      }),
    ]);
  }

  async boot() {
    this.onProgress(0.02, '加载 wasm 模块…');
    await loadScript(asset('rime.js'));
    this.M = await createRime({ locateFile: (f) => asset(f) });
    const raw = (n, r, a, v) => this.M.ccall(n, r, a, v);
    this.call = DEBUG ? (n, r, a, v) => {
      const out = raw(n, r, a, v);
      (window.__calls = window.__calls || []).push(n + ' ' + JSON.stringify(v || a || []) + ' -> ' + out);
      return out;
    } : raw;
    this.onProgress(0.06, 'wasm 就绪，加载共享数据…');

    await loadRimeData(this.M, this.call, {
      asset, image: 'data/base.img',
      onProgress: (p, s) => this.onProgress(0.06 + p * 0.09, s),
    });
    this.call('rime_wasm_init', 'number', ['string', 'string'], ['/shared', '/user']);

    this.ready = true;
    const first = this.pendingScheme || this.current || this.order[0];
    await this.useScheme(first);
  }

  /** 把某个方案的数据镜像挂进内存文件系统（挂过就不再拉） */
  async loadScheme(key) {
    if (this.loaded.has(key)) return false;
    const def = this.schemes[key];
    await loadRimeData(this.M, this.call, {
      asset, image: def.img,
      onProgress: (p, s) => this.onProgress(0.15 + p * 0.7, def.name + '：' + s),
    });
    this.loaded.add(key);
    return true;
  }

  /** 重启引擎（方案文件是 initialize 之后才挂上的，换镜像后重来一遍最干净） */
  reinit() {
    this.call('rime_wasm_shutdown', 'void', [], []);
    this.call('rime_wasm_init', 'number', ['string', 'string'], ['/shared', '/user']);
    this.token++;
  }

  /** select_schema + 重试：刚销毁会话 / 刚 initialize 完的头几次偶尔返回 0 */
  async selectSchema(retries) {
    let ok = 0;
    for (let i = 0; i < (retries || 6) && !ok; i++) {
      ok = this.call('rime_wasm_select', 'number', ['string'], [this.schemaId]);
      if (!ok) await this.sleep(90);
    }
    return ok;
  }

  /** 切到某个方案：要就拉它的镜像，拉完重启引擎，再 select_schema */
  async useScheme(key) {
    this.pendingScheme = key;
    if (!this.M) return 0;
    let wasFree = false, ok = 0;
    await this.locked(async () => {
      const same = this.current === key;
      wasFree = this.mode === 'free';
      this.token++;                       /* 作废正在跑的演示循环 */
      this.current = key;
      this.pendingScheme = null;
      /* 先清干净：组字浮层、已上屏文字、候选、按键记录都收掉，把位置让给进度条 */
      this.resetView();
      this.resetHud('加载中');
      this.el.ta.blur();
      if (wasFree && !same) await this.saveUserData();

      this.onProgress(0.05, this.schemes[key].name + '：准备数据…');
      const loaded = await this.loadScheme(key);
      this.call('rime_wasm_clear', 'void', [], []);
      if (loaded) {
        this.onProgress(0.9, '重新初始化 librime…');
        this.reinit();
      }

      ok = await this.selectSchema(4);
      if (!ok && !loaded) {                /* 实在不认就重启引擎再来一遍 */
        this.onProgress(0.9, '重新初始化 librime…');
        this.reinit();
        ok = await this.selectSchema(6);
      }
      this.onProgress(1, ok ? '就绪' : '选方案失败');
      this.resetView();
      this.el.live.textContent = this.schemaId;
    });
    /* 演示循环是「永不返回」的，必须在锁外面启动 —— 不然接下来所有操作都会排死在队列里 */
    if (wasFree) await this.enterFree();
    else if (this.visible) this.play();
    else this.onPhase('滚到预览框就开始演示');
    return ok;
  }

  /* -------------------------------------------------------------- 送键 */
  feed(key) {
    const kc = KEYCODE[key] !== undefined ? KEYCODE[key]
      : (key === 'space' ? 0x20 : key.charCodeAt(0));
    const ta = this.el.ta;
    const shapeBefore = key === '-' ? this.shapeSpans() : null;
    this.call('rime_wasm_key', 'number', ['number', 'number'], [kc, 0]);
    const commit = this.call('rime_wasm_commit', 'string', [], []);
    const raw = this.call('rime_wasm_state', 'string', [], []);
    let st = { input: '', preedit: '', candidates: [] };
    try { st = JSON.parse(raw); } catch (e) { /* 引擎抽风就当中断 */ }
    if (commit) {
      /* 顶功：这一键把上一个词顶上屏，同时接着组下一个词 —— 组字锚点在插入位置
         之后，得跟着往后挪，不然浮层会回头压在刚上屏的那几个字上。 */
      const at = ta.selectionStart;
      this.insertText(commit);
      if (this.compAnchor != null && this.compAnchor >= at) this.compAnchor += commit.length;
    }
    /* 排码把形码尾巴收短了 —— 被收掉的那几颗让它们掉下去 */
    if (shapeBefore) {
      const after = ((st.preedit || '').trim().split(/\s+/)[1] || '').length;
      if (shapeBefore.length > after) {
        this.dropShape(shapeBefore.length - after, shapeBefore);
      }
    }
    return { commit, st };
  }

  stateNow() {
    try {
      return JSON.parse(this.call('rime_wasm_state', 'string', [], []));
    } catch (e) {
      return { input: '', preedit: '', candidates: [] };
    }
  }

  clearComposition() {
    this.call('rime_wasm_clear', 'void', [], []);
    this.composing = false;
    this.compAnchor = null;
    this.lastState = { input: '', preedit: '' };
    this.renderOverlay(this.lastState);
    this.renderCands(null);
  }

  /* ------------------------------------------------------ textarea 操作 */
  get docText() { return this.el.ta.value; }

  /** 把引擎上屏的文字插到光标处。两种模式共用一条路径：
   *  可写时用 execCommand（保住浏览器原生撤销栈），readonly（演示）时退回 setRangeText。 */
  insertText(text) {
    if (!text) return;
    const ta = this.el.ta;
    this.inserting = true;
    try {
      const inserted = !ta.readOnly && document.execCommand('insertText', false, text);
      if (!inserted) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    } catch (e) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    }
    this.inserting = false;
    this.docValue = ta.value;
    this.scrollCaretIntoView();
  }

  /** 让光标那一行留在可视区（演示连着打字时尤其要，textarea 自己不一定滚） */
  scrollCaretIntoView() {
    const ta = this.el.ta;
    if (ta.scrollHeight <= ta.clientHeight + 1) { ta.scrollTop = 0; return; }
    const p = this.caretPos(ta.selectionStart);
    const top = p.taTop, bottom = p.taTop + p.height;
    if (top < 0) ta.scrollTop += top - 6;
    else if (bottom > ta.clientHeight) ta.scrollTop += bottom - ta.clientHeight + 6;
  }

  /** 从末尾删掉 n 个字符（演示的退格用） */
  trimEnd(n) {
    const ta = this.el.ta;
    ta.value = ta.value.slice(0, Math.max(0, ta.value.length - n));
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    this.docValue = ta.value;
  }

  setReadOnly(on) {
    this.el.ta.readOnly = !!on;
    this.el.ta.setAttribute('aria-readonly', on ? 'true' : 'false');
    this.root.classList.toggle('is-demo', !!on);
  }

  /* -------------------------------------------------------------- 渲染 */
  composeHTML(st) {
    if (!st) return '';
    const pre = (st.preedit || st.input || '').trim();
    if (!pre) return '';
    const [audio, ...rest] = pre.split(/\s+/);
    const shape = rest.join('');
    let out = '';
    for (const ch of audio) out += ch === '`' ? '<span class="mk">`</span>' : ch;
    if (shape) out += ' ' + [...shape].map((c) => '<span class="sh">' + c + '</span>').join('');
    return out;
  }

  /** 组字浮层：画在 textarea 里 compAnchor 那个位置 */
  renderOverlay(st) {
    if (st) this.lastState = st;                 /* 只重排（滚动/重绘）时不传，沿用上一次的状态 */
    st = this.lastState || { input: '', preedit: '' };
    const html = this.composing ? this.composeHTML(st) : '';
    const ov = this.el.ov;
    if (!html) {
      ov.classList.remove('on');
      ov.textContent = '';
      this.el.ta.style.caretColor = '';
      return;
    }
    ov.innerHTML = html + '<span class="ime-caret"></span>';
    ov.classList.add('on');
    this.el.ta.style.caretColor = 'transparent';   /* 自己画光标，别两个 */
    const p = this.caretPos(this.compAnchor == null ? this.el.ta.selectionStart : this.compAnchor);
    ov.style.left = p.left + 'px';
    ov.style.top = (p.top - p.halfLead) + 'px';
  }

  renderCands(st) {
    const list = ((st && st.candidates) || []).slice(0, 6);
    const box = this.el.cands;
    if (!list.length) { box.classList.remove('on'); return; }
    box.innerHTML = list.map((c, i) => {
      /* 引擎给的 comment 里可能带两个记号：「⛔️」不可顶功、「🔹」次简。
         记号画成 CSS 图形（emoji 在不同系统里高度差太多，会把整行撑变形），
         剩下的是提示键（一串字母），照原样显示。 */
      let comment = c.comment || '';
      let marks = '';
      let isSec = false;
      if (comment.includes('⛔️')) {
        marks += '<span class="mk mk-block" title="不可顶功"></span>';
        comment = comment.replace('⛔️', '');
      }
      if (comment.includes('🔹')) {
        marks += '<span class="mk mk-sec" title="次简：Tab 上屏／学习"></span>';
        comment = comment.replace('🔹', '');
        isSec = true;
      }
      const hint = comment ? '<span class="hint">' + comment + '</span>' : '';
      return '<div class="cd' + (isSec ? ' sec' : '') + '">' +
        '<span class="num">' + (i + 1) + '</span><span class="txt">' + c.text + '</span>' +
        (marks || hint ? '<span class="marks">' + hint + marks + '</span>' : '') + '</div>';
    }).join('');
    box.classList.add('on');
    this.placeCands();
  }

  /* --------------------------------------------------- 光标位置（镜像法） */
  caretPos(index) {
    const ta = this.el.ta;
    if (!this.mirror) {
      const m = document.createElement('div');
      m.className = 'ime-mirror';
      this.el.doc.appendChild(m);
      this.mirror = m;
    }
    const m = this.mirror;
    const cs = getComputedStyle(ta);
    for (const p of ['font', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
                     'letterSpacing', 'padding', 'boxSizing', 'textIndent',
                     'tabSize', 'wordBreak', 'overflowWrap', 'whiteSpace']) {
      m.style[p] = cs[p];
    }
    m.style.position = 'absolute';
    m.style.left = '0';
    m.style.top = '0';
    m.style.width = ta.clientWidth + 'px';
    m.style.height = 'auto';
    m.style.visibility = 'hidden';
    m.style.pointerEvents = 'none';
    m.style.whiteSpace = 'pre-wrap';
    m.style.wordBreak = 'break-all';
    m.textContent = ta.value.slice(0, Math.max(0, Math.min(index, ta.value.length)));
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    m.appendChild(mark);

    const mr = mark.getBoundingClientRect();
    const tr = ta.getBoundingClientRect();
    const dr = this.el.doc.getBoundingClientRect();
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.6 || 20);
    const x = mr.left - tr.left - ta.scrollLeft;
    const y = mr.top - tr.top - ta.scrollTop;
    /* mark 的 rect 是「字体盒」，比行盒矮 —— 浮层按行盒摆的话会往下偏半个行距，
       所以要减掉这半个行距（halfLead），文字才会和 textarea 里的对上。 */
    const halfLead = Math.max(0, (lh - mr.height) / 2);
    return {
      height: lh,
      halfLead: halfLead,
      /* 相对 textarea 内容盒（渲染浮层/Candidates 全用它） */
      docLeft: (tr.left - dr.left) + x,
      docTop: (tr.top - dr.top) + y,
      left: (tr.left - dr.left) + x,
      top: (tr.top - dr.top) + y,
      taLeft: x,
      taTop: y,
    };
  }

  placeCands() {
    const box = this.el.cands;
    if (!box.classList.contains('on')) return;
    const doc = this.el.doc.getBoundingClientRect();
    const ta = this.el.ta.getBoundingClientRect();
    const ov = this.el.ov;
    let ax, ay, ah;                       /* 锚点：组字浮层末尾，或者光标那一行的下沿 */
    if (ov.classList.contains('on')) {
      const r = ov.getBoundingClientRect();
      ax = r.left - doc.left;
      ay = r.bottom - doc.top;
      ah = r.height;
    } else {
      const p = this.caretPos(this.el.ta.selectionStart);
      ax = p.docLeft;
      ay = p.docTop - p.halfLead + p.height;
      ah = p.height;
    }
    const w = box.offsetWidth;
    const maxLeft = Math.max(8, ta.right - doc.left - 8 - w);
    const left = Math.min(Math.max(8, ax), maxLeft);
    /* 候选多的时候框会很高：默认贴在组字下面，最多用到文档底部，超了自己滚
       （翻上去会把组字盖住，所以只在下面真的放不下时才翻） */
    const below = ta.bottom - doc.top - ay - 8;
    box.style.maxHeight = 'none';
    if (below >= 110) {
      box.style.top = (ay + 4) + 'px';
      box.style.maxHeight = Math.min(360, below) + 'px';
    } else {
      const above = ay - ah - 8;
      box.style.maxHeight = Math.max(110, Math.min(360, above)) + 'px';
      box.style.top = Math.max(6, ay - ah - 4 - Math.min(box.offsetHeight, Math.max(110, above))) + 'px';
    }
    box.style.left = left + 'px';
  }

  applyState(st, key, commit) {
    /* 组字状态只看引擎的 input：刚上屏完（input 空）就把浮层收掉，交还给原生光标 */
    this.composing = !!(st && st.input);
    if (this.composing) {
      if (this.compAnchor == null) this.compAnchor = this.el.ta.selectionStart;
    } else {
      this.compAnchor = null;
    }
    this.renderOverlay(this.composing ? st : null);
    this.renderCands(st);
    if (key) this.showKey(key);
  }

  /* ----------------------------------------------------------- 键位说明 */
  keyInfo(k) {
    const L = this.layouts[this.current] || {};
    const shapeKeys = L.shapeKeys || this.schemes[this.current].shapeKeys || '';
    if (k === 'space') return ['空格', '上屏首选', 'small'];
    if (k === 'Tab') return ['Tab', '次简上屏', 'small'];
    if (k === '`') return ['`', '进入造词', 'small'];
    if (k === '-') return ['-', '排码 · 调频', 'gold'];
    if (k === '=') return ['=', '排码 · 降级', 'gold'];
    if (k === 'BackSpace') return ['⌫', '退格回空', 'small'];
    if (k === 'clear') return ['Esc', '清空', 'small'];
    if (/^[0-9]$/.test(k)) return [k, '数字选字', 'gray'];
    if (/^[,.;!?]$/.test(k)) return [k, '标点', 'gray'];
    if (shapeKeys.includes(k)) return [k.toUpperCase(), this.hintKey(k) ? '提示键 · 选字' : '笔码', ''];
    return [k.toUpperCase(), '音码', ''];
  }

  isSchemeKey(k) {
    const L = this.layouts[this.current] || {};
    return ((L.soundKeys || '') + (L.shapeKeys || '')).includes(k);
  }

  hintKey(k) {
    return this.lastCands.some((c) => c.comment && c.comment.split('').includes(k));
  }

  showKey(k) {
    this.onKey(k);                       /* 上面的键位图：每个键都亮 */
    if (!HUD_KEYS.includes(k)) return;   /* 只有排码键才冒这个浮层 */
    const [label, what, cls] = this.keyInfo(k);
    const cap = this.el.cap;
    cap.className = 'ime-cap' + (cls ? ' ' + cls : '') + (label.length > 1 ? ' small' : '');
    cap.textContent = label;
    this.el.capLbl.className = 'ime-caplbl' + (cls === 'gold' ? ' gold' : '');
    this.el.capLbl.textContent = what;
    cap.classList.remove('hit'); void cap.offsetWidth; cap.classList.add('hit');

    /* 瞬间出现（动画 0% 帧就是不透明），停久一点再淡出缩小 */
    const hud = this.el.hud;
    if (hud) {
      hud.classList.remove('pop');
      void hud.offsetWidth;
      hud.classList.add('pop');
    }
  }

  /* ---- 笔键掉落：按 - 把形码尾巴吃掉一个，那一颗就掉下去 ---- */
  shapeSpans() {
    return [...this.el.ov.querySelectorAll('.sh')];
  }

  dropShape(count, spans) {
    if (!count || !spans) return;
    const doc = this.el.doc.getBoundingClientRect();
    for (let i = spans.length - count; i < spans.length; i++) {
      const sp = spans[i];
      if (!sp || !sp.textContent) continue;
      const r = sp.getBoundingClientRect();
      const el = document.createElement('span');
      el.className = 'drop';
      el.textContent = sp.textContent;
      el.style.left = (r.left - doc.left) + 'px';
      el.style.top = (r.top - doc.top) + 'px';
      el.style.setProperty('--rot', (Math.random() * 54 - 27).toFixed(1) + 'deg');
      el.style.setProperty('--dx', (Math.random() * 28 - 14).toFixed(1) + 'px');
      el.style.animationDuration = (0.85 + Math.random() * 0.3).toFixed(2) + 's';
      this.el.doc.appendChild(el);
      setTimeout(() => el.remove(), 1500);
    }
  }

  /** 收掉右下角那个排码键浮层 */
  resetHud(label) {
    if (this.el.hud) this.el.hud.classList.remove('pop');
    if (this.el.cap) {
      this.el.cap.className = 'ime-cap';
      this.el.cap.textContent = '·';
    }
    if (this.el.capLbl) {
      this.el.capLbl.className = 'ime-caplbl';
      this.el.capLbl.textContent = label || '';
    }
  }

  resetView() {
    this.composing = false;
    this.compAnchor = null;
    this.el.ta.value = '';
    this.docValue = '';
    this.el.ta.selectionStart = this.el.ta.selectionEnd = 0;
    this.el.ta.scrollTop = 0;
    this.el.ov.classList.remove('on');
    this.el.ov.textContent = '';
    this.lastState = { input: '', preedit: '' };
    this.el.ta.style.caretColor = '';
    this.el.cands.classList.remove('on');
    this.el.cands.innerHTML = '';
    this.el.tip.style.display = this.mode === 'free' ? '' : 'none';
    this.resetHud();
  }

  /* -------------------------------------------------------------- 演示 */
  t(name) { return Math.max(25, Math.round((PACE[name] || PACE.normal) * this.speed)); }
  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** 预览框滚出视口：停掉演示并把界面复位（回来时从头再演一遍） */
  pauseDemo() {
    this.token++;              /* 作废正在跑的那一轮 */
    this.playing = false;
    if (this.M) {
      this.call('rime_wasm_clear', 'void', [], []);
      this.call('rime_wasm_select', 'number', ['string'], [this.schemaId]);
    }
    this.resetView();
    this.resetHud('暂停');
    this.onPhase('演示已暂停（滚回来看会重新开始）');
  }

  /** 由外部的 IntersectionObserver 调 */
  setVisible(v) {
    this.visible = !!v;
    if (!this.M) return;
    if (this.visible) {
      if (this.mode === 'demo' && !this.playing) this.play();
    } else if (this.playing) {
      this.pauseDemo();
    }
  }

  async play() {
    if (this.playing) return;
    this.playing = true;
    const script = this.demos[this.current];
    this.mode = 'demo';
    this.setReadOnly(true);
    this.el.tip.style.display = 'none';
    if (!script) { this.playing = false; this.onPhase('这个方案还没有演示脚本'); return; }
    try {
    while (this.mode === 'demo') {
      const my = ++this.token;
      this.round++;
      this.resetView();
      this.resetHud('复位');
      this.onPhase('用户数据复位…');
      this.call('rime_wasm_clear', 'void', [], []);
      this.resetUserData();
      await this.selectSchema();
      this.call('rime_wasm_clear', 'void', [], []);
      this.onPhase('用户数据已清空，开始');
      await this.sleep(this.t('reset'));
      if (my !== this.token) return;

      for (const step of script.steps) {
        if (my !== this.token) return;
        this.onPhase(step.title);
        await this.sleep(this.t('title'));
        if (my !== this.token) return;
        if (step.kind === 'erase') { await this.eraseAll(my); continue; }
        for (const key of step.keys) {
          if (my !== this.token) return;
          const before = this.stateNow();
          const { commit, st } = this.feed(key);
          this.lastCands = before.candidates || [];
          this.applyState(st, key);
          this.lastCands = st.candidates || [];
          await this.sleep(this.t(step.pace) + (commit ? this.t('hit') : 0));
        }
        if (step.promote) await this.promoteToTop(my);
        if (step.commit) {
          const { st } = this.feed('space');
          this.applyState(st, 'space');
          await this.sleep(this.t('commit'));
        }
        await this.sleep(this.t('gap'));
      }
      await this.sleep(this.t('end'));
    }
    } finally {
      this.playing = false;
    }
  }

  /** 退格回空：先把编码退干净，再把已上屏的字一个个删掉 */
  async eraseAll(my) {
    while (my === this.token) {
      const st = this.stateNow();
      if (!st.input) break;
      const { st: st2 } = this.feed('BackSpace');
      this.applyState(st2, 'BackSpace');
      await this.sleep(this.t('eraseKey'));
    }
    for (let j = this.docText.length; j > 0; j--) {
      if (my !== this.token) return;
      this.showKey('BackSpace');
      this.trimEnd(1);
      this.el.cands.classList.remove('on');
      this.renderOverlay();
      await this.sleep(this.t('eraseChar'));
    }
  }

  /** 调频到最高一级：只要 preedit 后面还挂着形码，就继续按 - */
  async promoteToTop(my) {
    for (let i = 0; i < 16; i++) {
      if (my !== this.token) return;
      const st = this.stateNow();
      if (!/\s/.test((st.preedit || '').trim())) break;
      const { st: st2 } = this.feed('-');
      this.applyState(st2, '-');
      await this.sleep(this.t('promote'));
    }
  }

  /* ------------------------------------------------------------ 演示/体验 */
  async setMode(m) {
    if (this.mode === m) return 0;
    const wasFree = this.mode === 'free';
    let ok = 0;
    await this.locked(async () => {
      this.token++;
      this.mode = m;
      if (wasFree) await this.saveUserData(true);
      this.call('rime_wasm_clear', 'void', [], []);
      this.resetUserData();
      this.resetView();
      if (m === 'free') {
        this.setReadOnly(false);
        ok = await this.enterFree();
      } else {
        this.setReadOnly(true);
        ok = await this.selectSchema();
        this.onStatus('演示中 · 用户数据每轮清空，你自己那份已存好');
      }
    });
    if (m === 'free') this.el.ta.focus();
    else if (this.visible) this.play();   /* 同上：循环在锁外跑；不在视口里就等滚到 */
    else this.onPhase('滚到预览框就开始演示');
    return ok;
  }

  async setModeNow(m) { return this.setMode(m); }

  async enterFree() {
    this.onPhase('体验模式 · 随便打');
    const n = await this.loadUserData();
    const ok = await this.selectSchema();
    if (!ok) this.onStatus('会话没建起来（select 失败），刷新页面试试');
    return ok;
    this.onStatus(n ? '已载入你的 ' + n + ' 个用户数据文件'
                    : '这份数据还是空的，打几个字试试（会自动存在浏览器里）');
  }

  /* ---------------------------------------------------- 体验模式的键盘 */
  onKeyDown(e) {
    if (!this.ready || this.mode !== 'free') return;
    const ta = this.el.ta;
    if (e.target !== ta) return;                 /* 只在输入框里接管 */
    if (e.ctrlKey || e.metaKey || e.altKey) return;   /* 复制粘贴 / 撤销：原生 */
    const L = this.layouts[this.current] || {};
    const soundKeys = L.soundKeys || '';
    const shapeKeys = L.shapeKeys || '';
    const k = e.key;
    const composing = this.composing;
    let key = null;
    if (k === 'Escape') key = composing ? 'clear' : null;
    else if (k === 'Tab') key = composing ? 'Tab' : null;
    else if (k === 'Enter') key = composing ? 'Enter' : null;
    else if (k === ' ') key = composing ? 'space' : null;
    else if (k === '`') key = '`';
    else if (k === '-' || k === '=') key = composing ? k : null;
    else if (/^[1-9]$/.test(k)) key = composing ? k : null;
    else if (k === 'Backspace') key = composing ? 'BackSpace' : null;
    else if (k.length === 1 && !e.shiftKey && (soundKeys.includes(k) || shapeKeys.includes(k))) key = k;
    /* 中文标点交给引擎（Rime 的 punct 表会把 , 变成 ，），引擎不理就直接打原字符 */
    else if (/^[,.;:!?]$/.test(k) && !e.shiftKey) key = k;
    if (!key) return;                            /* 其余（方向键 / Delete / 粘贴 / 英文…）交给 textarea */

    e.preventDefault();
    if (key === 'clear') { this.clearComposition(); return; }
    const before = this.stateNow();
    this.lastCands = before.candidates || [];
    const { commit, st } = this.feed(key);
    /* 引擎对这一个键什么都没做（既没上屏也没起组字）—— 那就当普通字符打进 textarea */
    if (!commit && !st.input && !st.preedit && key.length === 1 && !this.isSchemeKey(key)) {
      this.insertText(key);
      this.renderOverlay(null);
      this.renderCands(null);
      this.scheduleSave();
      return;
    }
    this.applyState(st, key);
    this.lastCands = st.candidates || [];
    this.scheduleSave();
  }

  /* ------------------------------------------------- 用户数据（IndexedDB） */
  get idbKey() { return 'userdb:' + this.schemaId; }

  openIdb() {
    if (this.idbBroken) return Promise.reject(new Error('浏览器存储不可用'));
    if (this.idbPromise) return this.idbPromise;
    this.idbPromise = new Promise((res, rej) => {
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this.idbBroken = true;
        this.onStatus('浏览器存储打不开（IndexedDB 无响应），这次的数据只留在内存里');
        rej(e instanceof Error ? e : new Error(String(e && e.name || e)));
      };
      let req;
      try { req = indexedDB.open('flow-ime-web', 2); } catch (e) { fail(e); return; }
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
        } catch (e) { /* 已经有了就算了 */ }
      };
      req.onsuccess = () => { if (!settled) { settled = true; res(req.result); } };
      req.onerror = () => fail(req.error);
      req.onblocked = () => fail(new Error('blocked'));
      setTimeout(() => fail(new Error('timeout')), 2500);   /* 卡住的库别等它 */
    });
    return this.idbPromise;
  }

  async idbDo(mode, fn) {
    const db = await this.openIdb();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  }

  collectUserData() {
    const files = {};
    const walk = (dir) => {
      for (const name of this.M.FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const p = dir + '/' + name;
        const st = this.M.FS.stat(p);
        if (this.M.FS.isDir(st.mode)) walk(p);
        else files[p] = new Uint8Array(this.M.FS.readFile(p));
      }
    };
    const prefix = this.schemaId + '.';
    for (const name of this.M.FS.readdir('/user')) {
      if (name === '.' || name === '..') continue;
      const p = '/user/' + name;
      const st = this.M.FS.stat(p);
      if (this.M.FS.isDir(st.mode)) {
        if (/\.userdb$/.test(name) && name.startsWith(prefix)) walk(p);
      } else if (USER_DATA_RE.test(name) && name.startsWith(prefix)) {
        files[p] = new Uint8Array(this.M.FS.readFile(p));
      }
    }
    return files;
  }

  /** 只清当前方案的 live 用户数据（别的方案在内存里那份不动） */
  resetUserData() {
    if (!this.M) return 0;
    const n = this.call('rime_wasm_reset_user_of', 'number', ['string'], [this.schemaId]);
    if (n >= 0) return n;
    return this.call('rime_wasm_reset_user', 'number', [], []);
  }

  async saveUserData(force) {
    if (!this.M || (this.mode !== 'free' && !force)) return;
    clearTimeout(this.saveTimer); this.saveTimer = null;
    try {
      const files = this.collectUserData();
      const n = Object.keys(files).length;
      if (!n) { this.onStatus('你的数据：空（浏览器里存的那份没动）'); return; }
      await this.idbDo('readwrite', (s) => s.put({ files, at: Date.now() }, this.idbKey));
      const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      this.onStatus('「' + this.schemes[this.current].name + '」已存到浏览器：' + n + ' 个文件 · ' + t);
    } catch (e) {
      this.onStatus('保存失败：' + ((e && e.message) || e));
    }
  }

  scheduleSave() {
    if (this.mode !== 'free') return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveUserData(true), 1200);
  }

  async loadUserData() {
    try {
      const rec = await this.idbDo('readonly', (s) => s.get(this.idbKey));
      if (!rec || !rec.files) return 0;
      const paths = Object.keys(rec.files);
      for (const p of paths) {
        this.M.FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
        this.M.FS.writeFile(p, rec.files[p]);
      }
      return paths.length;
    } catch (e) {
      this.onStatus('载入失败：' + ((e && e.message) || e));
      return 0;
    }
  }

  async clearUserData() {
    clearTimeout(this.saveTimer);
    try { await this.idbDo('readwrite', (s) => s.delete(this.idbKey)); } catch (e) { /* 忽略 */ }
    this.token++;
    this.resetView();
    this.call('rime_wasm_clear', 'void', [], []);
    this.resetUserData();
    await this.selectSchema();
    this.onStatus('已清空「' + this.schemes[this.current].name + '」的数据（内存和浏览器里都清了）');
  }
}

window.ImePreview = ImePreview;
