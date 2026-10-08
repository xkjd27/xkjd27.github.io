/* 三个方案的展示信息（键位表在 data/layouts.js、演示按键在 data/demos.js，
   都是 tools/wasm-build/export-data.sh 与 tools/record_demo.py 生成的 —— 这里只放
   手写的那部分：一句话介绍、仓库地址、说明。 */

window.FLOW_SCHEMES = {
  keytao: {
    name: '键道・函流',
    id: 'keytao_flow',
    blurb: '基于 RIME 键道6 的实时<b>排码造词</b>输入法',
    keyboard: '键道6 布局（QWERTY）',
    shapeKeys: 'auiov',
    img: 'data/keytao.img',
    repo: 'https://github.com/xkjd27/rime_keytao_flow',
    note: '基于键道6的函流输入法',
  },
  '27': {
    name: '贰柒・函流',
    id: 'xkjd27_flow',
    blurb: '基于 RIME 键道的 27 键<b>无飞键排码造词</b>输入法',
    keyboard: '27 键布局（QWERTY）',
    shapeKeys: 'auiov',
    img: 'data/27.img',
    repo: 'https://github.com/xkjd27/rime_jd27_flow',
    note: '去除飞键的类键道函流输入法',
  },
  '27c': {
    name: '贰柒C・函流',
    id: 'xkjd27c_flow',
    blurb: '基于 RIME 键道的 <b>Colemak</b> 排码造词输入法',
    keyboard: 'Colemak 布局',
    shapeKeys: 'aeiov',
    img: 'data/27c.img',
    repo: 'https://github.com/xkjd27/rime_jd27c_flow',
    note: '专为 Colemak 布局设计的函流输入法',
  },
};

window.FLOW_ORDER = ['keytao', '27', '27c'];
