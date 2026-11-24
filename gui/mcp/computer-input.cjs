const MODIFIERS = {
  control_l: { vk: 0x11, label: 'Control_L' },
  control: { vk: 0x11, label: 'Control_L' },
  ctrl: { vk: 0x11, label: 'Control_L' },
  control_r: { vk: 0xa3, label: 'Control_R' },
  ctrl_r: { vk: 0xa3, label: 'Control_R' },
  shift_l: { vk: 0x10, label: 'Shift_L' },
  shift: { vk: 0x10, label: 'Shift_L' },
  shift_r: { vk: 0xa1, label: 'Shift_R' },
  alt_l: { vk: 0x12, label: 'Alt_L' },
  alt: { vk: 0x12, label: 'Alt_L' },
  alt_r: { vk: 0xa5, label: 'Alt_R' },
};

const BLOCKED_KEYS = new Set([
  'meta',
  'meta_l',
  'meta_r',
  'windows',
  'windows_l',
  'windows_r',
  'win',
  'super',
  'super_l',
  'super_r',
  'cmd',
  'command',
  'os',
  'os_l',
  'os_r',
]);

const NAMED_KEYS = {
  enter: { vk: 0x0d },
  return: { vk: 0x0d },
  tab: { vk: 0x09 },
  escape: { vk: 0x1b },
  esc: { vk: 0x1b },
  backspace: { vk: 0x08 },
  space: { vk: 0x20 },
  delete: { vk: 0x2e, extended: true },
  insert: { vk: 0x2d, extended: true },
  home: { vk: 0x24, extended: true },
  end: { vk: 0x23, extended: true },
  pageup: { vk: 0x21, extended: true },
  page_up: { vk: 0x21, extended: true },
  prior: { vk: 0x21, extended: true },
  pagedown: { vk: 0x22, extended: true },
  page_down: { vk: 0x22, extended: true },
  next: { vk: 0x22, extended: true },
  up: { vk: 0x26, extended: true },
  down: { vk: 0x28, extended: true },
  left: { vk: 0x25, extended: true },
  right: { vk: 0x27, extended: true },
  capslock: { vk: 0x14 },
  printscreen: { vk: 0x2c, extended: true },
  pause: { vk: 0x13 },
  menu: { vk: 0x5d, extended: true },
  period: { vk: 0xbe },
  greater: { vk: 0xbe, implicitShift: true },
  comma: { vk: 0xbc },
  less: { vk: 0xbc, implicitShift: true },
  slash: { vk: 0xbf },
  question: { vk: 0xbf, implicitShift: true },
  semicolon: { vk: 0xba },
  colon: { vk: 0xba, implicitShift: true },
  apostrophe: { vk: 0xde },
  quote: { vk: 0xde },
  quotedbl: { vk: 0xde, implicitShift: true },
  bracketleft: { vk: 0xdb },
  braceleft: { vk: 0xdb, implicitShift: true },
  bracketright: { vk: 0xdd },
  braceright: { vk: 0xdd, implicitShift: true },
  backslash: { vk: 0xdc },
  bar: { vk: 0xdc, implicitShift: true },
  minus: { vk: 0xbd },
  underscore: { vk: 0xbd, implicitShift: true },
  equal: { vk: 0xbb },
  plus: { vk: 0xbb, implicitShift: true },
  grave: { vk: 0xc0 },
  asciitilde: { vk: 0xc0, implicitShift: true },
  kp_0: { vk: 0x60, extended: true },
  kp_1: { vk: 0x61, extended: true },
  kp_2: { vk: 0x62, extended: true },
  kp_3: { vk: 0x63, extended: true },
  kp_4: { vk: 0x64, extended: true },
  kp_5: { vk: 0x65, extended: true },
  kp_6: { vk: 0x66, extended: true },
  kp_7: { vk: 0x67, extended: true },
  kp_8: { vk: 0x68, extended: true },
  kp_9: { vk: 0x69, extended: true },
  kp_enter: { vk: 0x0d, extended: true },
  kp_add: { vk: 0x6b },
  kp_subtract: { vk: 0x6d },
  kp_multiply: { vk: 0x6a },
  kp_divide: { vk: 0x6f, extended: true },
  kp_decimal: { vk: 0x6e },
};

for (let index = 1; index <= 24; index += 1) {
  NAMED_KEYS[`f${index}`] = { vk: 0x6f + index };
}

const CHARACTER_KEYS = {
  '.': 'period',
  '>': 'greater',
  ',': 'comma',
  '<': 'less',
  '/': 'slash',
  '?': 'question',
  ';': 'semicolon',
  ':': 'colon',
  "'": 'apostrophe',
  '"': 'quotedbl',
  '[': 'bracketleft',
  '{': 'braceleft',
  ']': 'bracketright',
  '}': 'braceright',
  '\\': 'backslash',
  '|': 'bar',
  '-': 'minus',
  '_': 'underscore',
  '=': 'equal',
  '+': 'plus',
  '`': 'grave',
  '~': 'asciitilde',
};

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function resolvePrimaryKey(name) {
  const token = normalizeToken(name);
  if (BLOCKED_KEYS.has(token)) {
    throw new Error('禁止使用 Windows/Meta/Super/Cmd 键');
  }
  if (MODIFIERS[token]) {
    return { vk: MODIFIERS[token].vk, label: MODIFIERS[token].label };
  }
  if (NAMED_KEYS[token]) {
    return {
      vk: NAMED_KEYS[token].vk,
      extended: Boolean(NAMED_KEYS[token].extended),
      implicitShift: Boolean(NAMED_KEYS[token].implicitShift),
      label: token,
    };
  }
  if (CHARACTER_KEYS[token]) {
    return resolvePrimaryKey(CHARACTER_KEYS[token]);
  }
  if (/^numpad_(?:[0-9]|add|subtract|multiply|divide|decimal|enter)$/.test(token)) {
    return resolvePrimaryKey(token.replace('numpad_', 'kp_'));
  }
  if (/^[a-z]$/.test(token)) {
    return { vk: token.toUpperCase().charCodeAt(0), label: token };
  }
  if (/^[0-9]$/.test(token)) {
    return { vk: 0x30 + Number(token), label: token };
  }
  throw new Error(`不支持的按键：${String(name).trim()}`);
}

function parseComputerKeyChord(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('缺少按键');
  const tokens = raw.split('+').map((token) => token.trim());
  if (tokens.some((token) => !token)) throw new Error(`按键组合无效：${raw}`);
  const primaryToken = tokens.pop();
  const modifiers = [];
  const seenModifiers = new Set();
  for (const token of tokens) {
    const normalized = normalizeToken(token);
    if (BLOCKED_KEYS.has(normalized)) {
      throw new Error('禁止使用 Windows/Meta/Super/Cmd 键或快捷键');
    }
    const modifier = MODIFIERS[normalized];
    if (!modifier) throw new Error(`未知修饰键：${token}`);
    if (seenModifiers.has(modifier.vk)) continue;
    seenModifiers.add(modifier.vk);
    modifiers.push({ vk: modifier.vk, label: modifier.label });
  }
  const primary = resolvePrimaryKey(primaryToken);
  if (primary.implicitShift && !seenModifiers.has(0x10)) {
    seenModifiers.add(0x10);
    modifiers.push({ vk: 0x10, label: 'Shift_L' });
  }
  return {
    modifiers,
    primary: {
      vk: primary.vk,
      extended: Boolean(primary.extended),
      label: primary.label,
    },
    label: [
      ...modifiers.map((modifier) => modifier.label),
      primary.label,
    ].join('+'),
  };
}

function windowRelativePoint({ x, y, originX, originY, width, height }) {
  const localX = Number(x);
  const localY = Number(y);
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
    throw new Error('坐标无效');
  }
  const availableWidth = Number(width);
  const availableHeight = Number(height);
  if (
    Number.isFinite(availableWidth) &&
    availableWidth > 0 &&
    (localX < 0 || localX >= availableWidth)
  ) {
    throw new Error(`x=${localX} 超出窗口截图宽度 ${availableWidth}`);
  }
  if (
    Number.isFinite(availableHeight) &&
    availableHeight > 0 &&
    (localY < 0 || localY >= availableHeight)
  ) {
    throw new Error(`y=${localY} 超出窗口截图高度 ${availableHeight}`);
  }
  return {
    x: Math.round(Number(originX || 0) + localX),
    y: Math.round(Number(originY || 0) + localY),
    localX: Math.round(localX),
    localY: Math.round(localY),
  };
}

module.exports = {
  parseComputerKeyChord,
  windowRelativePoint,
};
