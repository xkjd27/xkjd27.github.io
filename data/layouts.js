/* 由 tools/wasm-build/export-data.sh 生成：键位表来自各方案 layout.py + 纯形码表。和 docs/layout.png 同一份计算。 */

/* 纯形码表：三套方案的笔码是同一份（只有落键不同），所以只存这里一遍。
   码里写的是笔形（乛 丨 丶 丿 ㇐），各方案的 shapeMap 负责把它换算成自己的键位。
   改笔码改这里。 */
window.FLOW_SHAPES = {
 "乛": [
  [
   "氵",
   ""
  ],
  [
   "贝",
   "丶"
  ],
 ],
 "丨": [
  [
   "亻",
   ""
  ],
  [
   "艹",
   "丨"
  ],
  [
   "钅",
   "丶"
  ],
  [
   "扌",
   "丿"
  ],
 ],
 "丶": [
  [
   "口",
   ""
  ],
  [
   "日",
   "丨"
  ],
 ],
 "丿": [
  [
   "月",
   ""
  ],
  [
   "十",
   "丶"
  ],
 ],
 "㇐": [
  [
   "木",
   ""
  ],
  [
   "土",
   "丶"
  ]
 ]
};

window.FLOW_LAYOUTS = {
 "27": {
  "keyboard": "qwerty",
  "keys": {
   ";": {
    "sheng": [
     "zh"
    ],
    "stroke": [],
    "yun": [
     "ü"
    ]
   },
   "a": {
    "sheng": [],
    "stroke": [
     "乛"
    ],
    "yun": []
   },
   "b": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "in",
     "ui"
    ]
   },
   "c": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "iao"
    ]
   },
   "d": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ou",
     "ie"
    ]
   },
   "e": {
    "sheng": [
     "sh"
    ],
    "stroke": [],
    "yun": [
     "e"
    ]
   },
   "f": {
    "sheng": [
     "y"
    ],
    "stroke": [],
    "yun": [
     "an"
    ]
   },
   "g": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "uai",
     "ing"
    ]
   },
   "h": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ai",
     "ue"
    ]
   },
   "i": {
    "sheng": [],
    "stroke": [
     "丨"
    ],
    "yun": []
   },
   "j": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "u",
     "er"
    ]
   },
   "k": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "i"
    ]
   },
   "l": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "uo",
     "o"
    ]
   },
   "m": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ian"
    ]
   },
   "n": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "en"
    ]
   },
   "o": {
    "sheng": [],
    "stroke": [
     "丶"
    ],
    "yun": []
   },
   "p": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ang"
    ]
   },
   "q": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ua",
     "iu"
    ]
   },
   "r": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "eng"
    ]
   },
   "s": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "a",
     "ia"
    ]
   },
   "t": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "uan"
    ]
   },
   "u": {
    "sheng": [],
    "stroke": [
     "丿"
    ],
    "yun": []
   },
   "v": {
    "sheng": [],
    "stroke": [
     "㇐"
    ],
    "yun": []
   },
   "w": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ei",
     "un"
    ]
   },
   "x": {
    "sheng": [
     "~"
    ],
    "stroke": [],
    "yun": [
     "iang",
     "uang"
    ]
   },
   "y": {
    "sheng": [
     "ch"
    ],
    "stroke": [],
    "yun": [
     "ong",
     "iong"
    ]
   },
   "z": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ao"
    ]
   }
  },
  "name": "",
  "rows": [
   "qwertyuiop",
   "asdfghjkl;",
   "zxcvbnm"
  ],
  "shapeKeys": "aiouv",
  "shapeMap": {
   "乛": "a",
   "丨": "i",
   "丶": "o",
   "丿": "u",
   "㇐": "v"
  },
  "soundKeys": ";bcdefghjklmnpqrstwxyz",
  "title": ""
 },
 "27c": {
  "keyboard": "colemak",
  "keys": {
   ";": {
    "sheng": [
     "zh"
    ],
    "stroke": [],
    "yun": [
     "ü"
    ]
   },
   "a": {
    "sheng": [],
    "stroke": [
     "乛"
    ],
    "yun": []
   },
   "b": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "in",
     "ui"
    ]
   },
   "c": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "iao"
    ]
   },
   "d": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "uai",
     "ing"
    ]
   },
   "e": {
    "sheng": [],
    "stroke": [
     "丿"
    ],
    "yun": []
   },
   "f": {
    "sheng": [
     "y"
    ],
    "stroke": [],
    "yun": [
     "e"
    ]
   },
   "g": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "uan"
    ]
   },
   "h": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ai",
     "ue"
    ]
   },
   "i": {
    "sheng": [],
    "stroke": [
     "丨"
    ],
    "yun": []
   },
   "j": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ong",
     "iong"
    ]
   },
   "k": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "en"
    ]
   },
   "l": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ang"
    ]
   },
   "m": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ian"
    ]
   },
   "n": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "u",
     "er"
    ]
   },
   "o": {
    "sheng": [],
    "stroke": [
     "丶"
    ],
    "yun": []
   },
   "p": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "eng"
    ]
   },
   "q": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ua",
     "iu"
    ]
   },
   "r": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "a",
     "ia"
    ]
   },
   "s": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ou",
     "ie"
    ]
   },
   "t": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "an"
    ]
   },
   "u": {
    "sheng": [
     "sh"
    ],
    "stroke": [],
    "yun": [
     "uo",
     "o"
    ]
   },
   "v": {
    "sheng": [],
    "stroke": [
     "㇐"
    ],
    "yun": []
   },
   "w": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ei",
     "un"
    ]
   },
   "x": {
    "sheng": [
     "~"
    ],
    "stroke": [],
    "yun": [
     "iang",
     "uang"
    ]
   },
   "y": {
    "sheng": [
     "ch"
    ],
    "stroke": [],
    "yun": [
     "i"
    ]
   },
   "z": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ao"
    ]
   }
  },
  "name": "",
  "rows": [
   "qwfpgjluy;",
   "arstdhneio",
   "zxcvbkm"
  ],
  "shapeKeys": "aeiov",
  "shapeMap": {
   "乛": "a",
   "丨": "i",
   "丶": "o",
   "丿": "e",
   "㇐": "v"
  },
  "soundKeys": ";bcdfghjklmnpqrstuwxyz",
  "title": ""
 },
 "keytao": {
  "keyboard": "qwerty",
  "keys": {
   "a": {
    "sheng": [],
    "stroke": [
     "乛"
    ],
    "yun": []
   },
   "b": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "in",
     "ui"
    ]
   },
   "c": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "iao"
    ]
   },
   "d": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ie",
     "ou"
    ]
   },
   "e": {
    "sheng": [
     "sh"
    ],
    "stroke": [],
    "yun": [
     "e"
    ]
   },
   "f": {
    "sheng": [
     "zh"
    ],
    "stroke": [],
    "yun": [
     "an"
    ]
   },
   "g": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ing",
     "uai"
    ]
   },
   "h": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ai",
     "ue"
    ]
   },
   "i": {
    "sheng": [],
    "stroke": [
     "丨"
    ],
    "yun": []
   },
   "j": {
    "sheng": [
     "ch"
    ],
    "stroke": [],
    "yun": [
     "er",
     "u"
    ]
   },
   "k": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "i"
    ]
   },
   "l": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "o",
     "uo",
     "ü"
    ]
   },
   "m": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ian",
     "uang"
    ]
   },
   "n": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "en"
    ]
   },
   "o": {
    "sheng": [],
    "stroke": [
     "丶"
    ],
    "yun": []
   },
   "p": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ang"
    ]
   },
   "q": {
    "sheng": [
     "zh"
    ],
    "stroke": [],
    "yun": [
     "iu",
     "ua"
    ]
   },
   "r": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "eng"
    ]
   },
   "s": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "a",
     "ia"
    ]
   },
   "t": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "uan"
    ]
   },
   "u": {
    "sheng": [],
    "stroke": [
     "丿"
    ],
    "yun": []
   },
   "v": {
    "sheng": [],
    "stroke": [
     "㇐"
    ],
    "yun": []
   },
   "w": {
    "sheng": [
     "ch"
    ],
    "stroke": [],
    "yun": [
     "ei",
     "un"
    ]
   },
   "x": {
    "sheng": [
     "~"
    ],
    "stroke": [],
    "yun": [
     "iang",
     "uang"
    ]
   },
   "y": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "iong",
     "ong"
    ]
   },
   "z": {
    "sheng": [],
    "stroke": [],
    "yun": [
     "ao"
    ]
   }
  },
  "name": "",
  "rows": [
   "qwertyuiop",
   "asdfghjkl;",
   "zxcvbnm"
  ],
  "shapeKeys": "aiouv",
  "shapeMap": {
   "乛": "a",
   "丨": "i",
   "丶": "o",
   "丿": "u",
   "㇐": "v"
  },
  "soundKeys": "bcdefghjklmnpqrstwxyz",
  "title": ""
 }
};
