/* Dither-Werkstatt: 1-Bit- und ASCII-Editor. Reines JavaScript, kein Build-Schritt. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // Eine Zelle ist 8 × 16 Einheiten groß (Verhältnis einer Monospace-Schrift).
  const BASE_W = 8, BASE_H = 16;
  const ZOOMS = [0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4];
  const MAX_COLS = 300, MAX_ROWS = 200;
  const MAX_CANVAS = 8192;

  // ---------- Zeichensätze ----------
  const FINE = '$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,"^`\'. '.split('').reverse().join('');
  const SETS = {
    braille: { name: 'Braille', grid: [2, 4], sample: '⣿⡷⢾⠶⡀' },
    quad:    { name: 'Viertelblöcke', grid: [2, 2], sample: '▛▜▙▟▚' },
    half:    { name: 'Halbblöcke', grid: [1, 2], sample: '▀▄█▀▄' },
    bit:     { name: '1-Bit-Block', ramp: ' █', sample: '█ █ █' },
    shade:   { name: 'Schattierung', ramp: ' ░▒▓█', sample: '░▒▓█' },
    ascii:   { name: 'ASCII klassisch', ramp: ' .:-=+*#%@', sample: '.:+*#@' },
    fine:    { name: 'ASCII fein', ramp: FINE, sample: '\'icXO#M' },
  };
  const gridOf = (key) => SETS[key].grid || [1, 1];

  // Viertelblöcke: Index = TL*8 + TR*4 + BL*2 + BR
  const QUAD = [' ', '▗', '▖', '▄', '▝', '▐', '▞', '▟', '▘', '▚', '▌', '▙', '▀', '▜', '▛', '█'];
  const QUAD_INDEX = {};
  QUAD.forEach((c, i) => { if (i) QUAD_INDEX[c] = i; });

  // Feinste Auflösung: 2 × 4 Bit pro Zelle, Bit-Index = Zeile * 2 + Spalte
  const DOT_IDX = [0, 2, 4, 1, 3, 5, 6, 7]; // Braille-Punkt k -> Bit-Index
  const quadToMask = (q) => (q & 8 ? 0x05 : 0) | (q & 4 ? 0x0A : 0) | (q & 2 ? 0x50 : 0) | (q & 1 ? 0xA0 : 0);
  const maskToQuad = (m) => (m & 0x05 ? 8 : 0) | (m & 0x0A ? 4 : 0) | (m & 0x50 ? 2 : 0) | (m & 0xA0 ? 1 : 0);
  function brailleToMask(code) {
    let m = 0;
    for (let k = 0; k < 8; k++) if (code & (1 << k)) m |= 1 << DOT_IDX[k];
    return m;
  }
  function maskToBraille(m) {
    let code = 0;
    for (let k = 0; k < 8; k++) if (m & (1 << DOT_IDX[k])) code |= 1 << k;
    return String.fromCharCode(0x2800 + code);
  }
  function charToMask(ch) {
    if (ch === ' ') return 0;
    const q = QUAD_INDEX[ch];
    if (q !== undefined) return quadToMask(q);
    const c = ch.charCodeAt(0);
    if (c >= 0x2800 && c <= 0x28ff) return brailleToMask(c - 0x2800);
    return null;
  }
  const maskOf = (ch) => { const m = charToMask(ch); return m === null ? (ch.trim() === '' ? 0 : 255) : m; };
  function maskToChar(m, key) {
    const set = SETS[key];
    if (key === 'braille') return maskToBraille(m);
    if (key === 'quad') return QUAD[maskToQuad(m)];
    if (key === 'half') return QUAD[(m & 0x0F ? 12 : 0) | (m & 0xF0 ? 3 : 0)];
    return m ? set.ramp[set.ramp.length - 1] : ' ';
  }
  // Bit-Maske eines Unterpixels (i, j) im Raster eines Zeichensatzes
  const REGION = {};
  for (const key of Object.keys(SETS)) {
    const [sx, sy] = gridOf(key);
    const list = [];
    for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
      let m = 0;
      const per = 4 / sy;
      for (let r = j * per; r < (j + 1) * per; r++) for (let c = 0; c < 2; c++) {
        if (sx === 2 && c !== i) continue;
        m |= 1 << (r * 2 + c);
      }
      list.push(m);
    }
    REGION[key] = list;
  }
  const isBlank = (ch) => ch === ' ' || ch === '⠀';
  const SHADES = { '░': 1, '▒': 2, '▓': 3 };

  // ---------- Zustand ----------
  const S = {
    cols: 100, rows: 40, grid: [],
    set: 'braille', tool: 'pen', brush: 'dot', char: '█',
    fg: '#e9ebfb', bg: '#10112c', zoom: 1,
    imgCols: 100, algo: 'atkinson', bright: 0, contrast: 0, gamma: 1, invert: false,
    pngScale: 2,
  };
  let image = null, imageName = '';
  let undoStack = [], redoStack = [];
  let adjusting = false; // mehrere Reglerbewegungen = ein Schritt zum Zurücknehmen
  let rec = null;        // Vorschau von Linie/Rechteck: ursprüngliche Zellen
  let cursor = null;     // Textcursor {c, r, c0}
  let hover = null;

  const blankGrid = (n) => new Array(n).fill(' ');

  // ---------- Zeichnen ----------
  const stage = $('#stage'), cv = $('#cv'), ov = $('#ov');
  const ctx = cv.getContext('2d'), octx = ov.getContext('2d');
  let cw = 8, ch = 16, dpr = 1, pats = {};

  function shadePattern(g, level, w, fg) {
    const p = Math.max(1, Math.round(w / 8));
    const t = document.createElement('canvas');
    t.width = t.height = 2 * p;
    const tc = t.getContext('2d');
    tc.fillStyle = fg;
    tc.fillRect(0, 0, p, p);
    if (level >= 2) tc.fillRect(p, p, p, p);
    if (level >= 3) tc.fillRect(p, 0, p, p);
    return g.createPattern(t, 'repeat');
  }
  function makePats(g, w, fg) {
    return { '░': shadePattern(g, 1, w, fg), '▒': shadePattern(g, 2, w, fg), '▓': shadePattern(g, 3, w, fg) };
  }
  function fontFor(w) { return `${Math.round(w / 0.6)}px "Plex Mono", ui-monospace, monospace`; }

  function paintGlyph(g, chr, x, y, w, h, fg, pc) {
    if (isBlank(chr)) return;
    const q = QUAD_INDEX[chr];
    if (q !== undefined) {
      const hw = Math.round(w / 2), hh = Math.round(h / 2);
      if (q & 8) g.fillRect(x, y, hw, hh);
      if (q & 4) g.fillRect(x + hw, y, w - hw, hh);
      if (q & 2) g.fillRect(x, y + hh, hw, h - hh);
      if (q & 1) g.fillRect(x + hw, y + hh, w - hw, h - hh);
      return;
    }
    const code = chr.charCodeAt(0);
    if (code >= 0x2800 && code <= 0x28ff) {
      const m = brailleToMask(code - 0x2800);
      const sw = w / 2, sh = h / 4, d = Math.max(1, Math.round(Math.min(sw, sh) * 0.72));
      for (let b = 0; b < 8; b++) {
        if (!(m & (1 << b))) continue;
        const c = b & 1, r = b >> 1;
        g.fillRect(x + Math.round(c * sw + (sw - d) / 2), y + Math.round(r * sh + (sh - d) / 2), d, d);
      }
      return;
    }
    if (SHADES[chr]) {
      g.fillStyle = pc[chr];
      g.fillRect(x, y, w, h);
      g.fillStyle = fg;
      return;
    }
    g.fillText(chr, x + w / 2, y + h / 2 + h * 0.03);
  }

  function prepCtx(g, w) {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = fontFor(w);
    g.fillStyle = S.fg;
  }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    cw = Math.max(2, Math.round(BASE_W * S.zoom * dpr));
    cw = Math.min(cw, Math.floor(MAX_CANVAS / S.cols), Math.floor(MAX_CANVAS / (2 * S.rows)));
    cw = Math.max(2, cw);
    ch = cw * 2;
    cv.width = ov.width = S.cols * cw;
    cv.height = ov.height = S.rows * ch;
    const cssW = (S.cols * cw / dpr) + 'px', cssH = (S.rows * ch / dpr) + 'px';
    cv.style.width = ov.style.width = cssW;
    cv.style.height = ov.style.height = cssH;
    redrawAll();
    updateStatus();
  }

  function redrawAll() {
    ctx.fillStyle = S.bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    pats = makePats(ctx, cw, S.fg);
    prepCtx(ctx, cw);
    for (let r = 0, i = 0; r < S.rows; r++) for (let c = 0; c < S.cols; c++, i++) {
      if (!isBlank(S.grid[i])) paintGlyph(ctx, S.grid[i], c * cw, r * ch, cw, ch, S.fg, pats);
    }
    drawOverlay();
  }

  function drawCellAt(i) {
    const c = i % S.cols, r = (i / S.cols) | 0;
    ctx.fillStyle = S.bg;
    ctx.fillRect(c * cw, r * ch, cw, ch);
    ctx.fillStyle = S.fg;
    paintGlyph(ctx, S.grid[i], c * cw, r * ch, cw, ch, S.fg, pats);
  }

  function setCell(i, chr) {
    if (i < 0 || i >= S.grid.length || S.grid[i] === chr) return;
    if (rec && !rec.has(i)) rec.set(i, S.grid[i]);
    S.grid[i] = chr;
    drawCellAt(i);
    scheduleSave();
  }

  function drawOverlay() {
    octx.clearRect(0, 0, ov.width, ov.height);
    const lw = Math.max(1, Math.round(dpr));
    octx.lineWidth = lw;
    if (hover && S.tool !== 'pan') {
      octx.strokeStyle = '#8c8cff';
      if (hover.dot) {
        const [sx, sy] = gridOf(S.set);
        const w = cw / sx, h = ch / sy;
        octx.strokeRect(hover.x * w + lw / 2, hover.y * h + lw / 2, w - lw, h - lw);
      } else {
        octx.strokeRect(hover.c * cw + lw / 2, hover.r * ch + lw / 2, cw - lw, ch - lw);
      }
    }
    if (cursor && S.tool === 'text') {
      octx.fillStyle = '#2424ff';
      octx.fillRect(cursor.c * cw, cursor.r * ch + ch - Math.max(2, lw * 2), cw, Math.max(2, lw * 2));
      octx.strokeStyle = '#2424ff';
      octx.strokeRect(cursor.c * cw + lw / 2, cursor.r * ch + lw / 2, cw - lw, ch - lw);
    }
  }

  // ---------- Zurück / Vor ----------
  const snap = () => ({ cols: S.cols, rows: S.rows, grid: S.grid.slice() });
  function pushUndo() {
    undoStack.push(snap());
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }
  function restore(st) {
    const resized = st.cols !== S.cols || st.rows !== S.rows;
    S.cols = st.cols; S.rows = st.rows; S.grid = st.grid.slice();
    cursor = null;
    if (resized) { layout(); syncSizeInputs(); } else redrawAll();
    scheduleSave();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snap());
    restore(undoStack.pop());
    adjusting = false;
    updateHistoryButtons();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snap());
    restore(redoStack.pop());
    adjusting = false;
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    $('#undo').disabled = !undoStack.length;
    $('#redo').disabled = !redoStack.length;
  }

  // ---------- Bild umrechnen ----------
  function bayer(n) {
    let m = [[0, 2], [3, 1]];
    while (m.length < n) {
      const s = m.length, next = [];
      for (let y = 0; y < s * 2; y++) {
        next.push([]);
        for (let x = 0; x < s * 2; x++) {
          const base = m[y % s][x % s] * 4;
          const add = [[0, 2], [3, 1]][(y / s) | 0][(x / s) | 0];
          next[y].push(base + add);
        }
      }
      m = next;
    }
    const flat = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) flat[y * n + x] = (m[y][x] + 0.5) / (n * n);
    return flat;
  }
  const B4 = bayer(4), B8 = bayer(8);
  const CLUSTER = Float32Array.from([12, 5, 6, 13, 4, 0, 1, 7, 11, 3, 2, 8, 15, 10, 9, 14], (v) => (v + 0.5) / 16);

  function dither(v, W, H, N, algo) {
    const out = new Uint8Array(W * H), M = N - 1;
    const cl = (q) => (q < 0 ? 0 : q > M ? M : q);
    if (algo === 'floyd' || algo === 'atkinson') {
      const e = Float32Array.from(v);
      for (let y = 0; y < H; y++) {
        const rev = algo === 'floyd' && (y & 1);
        for (let k = 0; k < W; k++) {
          const x = rev ? W - 1 - k : k, i = y * W + x;
          const old = e[i];
          const q = cl(Math.round(old * M));
          out[i] = q;
          const err = old - q / M;
          if (algo === 'floyd') {
            const d = rev ? -1 : 1;
            if (x + d >= 0 && x + d < W) e[i + d] += err * 7 / 16;
            if (y + 1 < H) {
              if (x - d >= 0 && x - d < W) e[i + W - d] += err * 3 / 16;
              e[i + W] += err * 5 / 16;
              if (x + d >= 0 && x + d < W) e[i + W + d] += err / 16;
            }
          } else {
            const f = err / 8;
            if (x + 1 < W) e[i + 1] += f;
            if (x + 2 < W) e[i + 2] += f;
            if (y + 1 < H) {
              if (x > 0) e[i + W - 1] += f;
              e[i + W] += f;
              if (x + 1 < W) e[i + W + 1] += f;
            }
            if (y + 2 < H) e[i + 2 * W] += f;
          }
        }
      }
      return out;
    }
    for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
      let t;
      switch (algo) {
        case 'bayer8': t = B8[(y & 7) * 8 + (x & 7)]; break;
        case 'bayer4': t = B4[(y & 3) * 4 + (x & 3)]; break;
        case 'cluster': t = CLUSTER[(y & 3) * 4 + (x & 3)]; break;
        case 'lines': t = ((y % 4) + 0.5) / 4; break;
        case 'random': t = Math.random(); break;
        default: t = 0.5;
      }
      out[i] = cl(Math.floor(v[i] * M + t));
    }
    return out;
  }

  function lum(hex) {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  }

  function convert() {
    if (!image) return;
    const set = SETS[S.set], [sx, sy] = gridOf(S.set);
    const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
    const cols = Math.max(4, Math.min(MAX_COLS, S.imgCols));
    const rows = Math.max(2, Math.min(MAX_ROWS, Math.round(cols * ih / iw * BASE_W / BASE_H)));
    const W = cols * sx, H = rows * sy;
    const oc = document.createElement('canvas');
    oc.width = W; oc.height = H;
    const g = oc.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(image, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const v = new Float32Array(W * H);
    const inkLight = lum(S.fg) > lum(S.bg);
    const cf = Math.tan((S.contrast / 100 * 0.98 + 1) * Math.PI / 4);
    const gi = 1 / S.gamma;
    for (let i = 0, k = 0; i < v.length; i++, k += 4) {
      let L = (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]) / 255;
      L = (L - 0.5) * cf + 0.5 + S.bright / 200;
      L = L < 0 ? 0 : L > 1 ? 1 : L;
      L = Math.pow(L, gi);
      let cov = inkLight ? L : 1 - L;
      if (S.invert) cov = 1 - cov;
      v[i] = cov * (d[k + 3] / 255);
    }
    const N = set.ramp ? set.ramp.length : 2;
    const q = dither(v, W, H, N, S.algo);
    const grid = new Array(cols * rows);
    if (set.ramp) {
      for (let i = 0; i < grid.length; i++) grid[i] = set.ramp[q[i]];
    } else {
      const reg = REGION[S.set];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        let m = 0;
        for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
          if (q[(r * sy + j) * W + c * sx + i]) m |= reg[j * sx + i];
        }
        grid[r * cols + c] = maskToChar(m, S.set);
      }
    }
    const resized = cols !== S.cols || rows !== S.rows;
    S.cols = cols; S.rows = rows; S.grid = grid;
    cursor = null;
    if (resized) { layout(); syncSizeInputs(); } else redrawAll();
    scheduleSave();
  }

  function reconvert() {
    if (!image) return;
    if (!adjusting) { pushUndo(); adjusting = true; }
    convert();
  }

  function loadImageFrom(src, name, isDemo, done) {
    const img = new Image();
    img.onload = () => {
      image = img; imageName = name;
      pushUndo(); adjusting = true;
      convert();
      if (!isDemo) fitZoom();
      $('#imgNote').textContent = isDemo ? 'Beispielbild geladen. Öffne ein eigenes Bild oder zeichne los.' : `Bild: ${name}`;
      if (done) done();
    };
    img.onerror = () => toast('Das Bild konnte nicht gelesen werden.');
    img.src = src;
  }
  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) { toast('Bitte eine Bilddatei wählen.'); return; }
    const url = URL.createObjectURL(file);
    loadImageFrom(url, file.name || 'Bild', false);
  }

  // Beispielbild: beleuchtete Kugel mit Ring auf einem Sockel
  function demoImage() {
    const W = 800, H = 520, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    // Strahlen
    g.save();
    g.translate(W / 2, 210);
    for (let k = 0; k < 36; k++) {
      g.rotate(Math.PI / 18);
      const grd = g.createLinearGradient(0, 0, 420, 0);
      grd.addColorStop(0, 'rgba(255,255,255,0.0)');
      grd.addColorStop(0.35, 'rgba(255,255,255,0.22)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(420, -10); g.lineTo(420, 10); g.closePath(); g.fill();
    }
    g.restore();
    // Ring hinten
    g.lineWidth = 10; g.strokeStyle = '#8a8a8a';
    g.beginPath(); g.ellipse(W / 2, 210, 210, 52, -0.25, Math.PI, 2 * Math.PI); g.stroke();
    // Kugel
    const s = g.createRadialGradient(W / 2 - 50, 160, 8, W / 2, 210, 140);
    s.addColorStop(0, '#ffffff'); s.addColorStop(0.45, '#9a9a9a'); s.addColorStop(0.85, '#262626'); s.addColorStop(1, '#0c0c0c');
    g.fillStyle = s;
    g.beginPath(); g.arc(W / 2, 210, 140, 0, 2 * Math.PI); g.fill();
    // Ring vorne
    g.strokeStyle = '#d8d8d8';
    g.beginPath(); g.ellipse(W / 2, 210, 210, 52, -0.25, 0, Math.PI); g.stroke();
    // Sockel
    const p = g.createLinearGradient(W / 2 - 160, 0, W / 2 + 160, 0);
    p.addColorStop(0, '#202020'); p.addColorStop(0.3, '#d0d0d0'); p.addColorStop(1, '#151515');
    g.fillStyle = p;
    g.fillRect(W / 2 - 150, 372, 300, 22);
    g.fillRect(W / 2 - 120, 394, 240, 46);
    g.fillRect(W / 2 - 170, 440, 340, 18);
    return c.toDataURL('image/png');
  }
  function loadDemo() {
    S.set = 'braille'; S.algo = 'atkinson'; S.bright = 0; S.contrast = 10; S.gamma = 1; S.invert = false;
    S.imgCols = window.innerWidth < 600 ? 72 : 110;
    syncControls();
    loadImageFrom(demoImage(), 'Beispiel', true, () => {
      // Bildunterschrift als normaler Text in die Zeichnung setzen
      const text = 'DITHER-WERKSTATT';
      const r = S.rows - 2, c0 = Math.max(0, ((S.cols - text.length) / 2) | 0);
      for (let k = 0; k < text.length && c0 + k < S.cols; k++) S.grid[r * S.cols + c0 + k] = text[k];
      redrawAll();
      fitZoom();
      scheduleSave();
    });
  }

  // ---------- Werkzeuge ----------
  function surface(erase) {
    if (S.brush === 'dot') {
      const [sx, sy] = gridOf(S.set), reg = REGION[S.set];
      return {
        w: S.cols * sx, h: S.rows * sy, ink: erase ? 0 : 1,
        get(x, y) {
          const i = ((y / sy) | 0) * S.cols + ((x / sx) | 0);
          return maskOf(S.grid[i]) & reg[(y % sy) * sx + (x % sx)] ? 1 : 0;
        },
        set(x, y, v) {
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
          const i = ((y / sy) | 0) * S.cols + ((x / sx) | 0);
          const old = maskOf(S.grid[i]), rm = reg[(y % sy) * sx + (x % sx)];
          const m = v ? old | rm : old & ~rm;
          if (m === old) return;
          setCell(i, maskToChar(m, S.set));
        },
      };
    }
    return {
      w: S.cols, h: S.rows, ink: erase ? ' ' : S.char,
      get(x, y) { const c = S.grid[y * S.cols + x]; return isBlank(c) ? ' ' : c; },
      set(x, y, v) {
        if (x < 0 || y < 0 || x >= S.cols || y >= S.rows) return;
        setCell(y * S.cols + x, v);
      },
    };
  }

  function line(sf, x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const stx = x0 < x1 ? 1 : -1, sty = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      sf.set(x0, y0, sf.ink);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += stx; }
      if (e2 <= dx) { err += dx; y0 += sty; }
    }
  }
  function rectOutline(sf, x0, y0, x1, y1) {
    line(sf, x0, y0, x1, y0); line(sf, x1, y0, x1, y1);
    line(sf, x1, y1, x0, y1); line(sf, x0, y1, x0, y0);
  }
  function flood(sf, x, y) {
    if (x < 0 || y < 0 || x >= sf.w || y >= sf.h) return;
    const target = sf.get(x, y);
    if (target === sf.ink) return;
    const seen = new Uint8Array(sf.w * sf.h);
    const stack = [x, y];
    while (stack.length) {
      const py = stack.pop(), px = stack.pop();
      if (px < 0 || py < 0 || px >= sf.w || py >= sf.h) continue;
      const k = py * sf.w + px;
      if (seen[k] || sf.get(px, py) !== target) continue;
      seen[k] = 1;
      sf.set(px, py, sf.ink);
      stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
    }
  }
  function restorePreview() {
    if (!rec) return;
    for (const [i, c] of rec) { S.grid[i] = c; drawCellAt(i); }
    rec.clear();
  }

  function pointFromEvent(e) {
    const r = cv.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width * S.cols;
    const fy = (e.clientY - r.top) / r.height * S.rows;
    const c = Math.floor(fx), rr = Math.floor(fy);
    const inside = c >= 0 && rr >= 0 && c < S.cols && rr < S.rows;
    const dot = S.brush === 'dot' && S.tool !== 'text' && S.tool !== 'pick';
    const [sx, sy] = gridOf(S.set);
    return { c, r: rr, x: Math.floor(fx * sx), y: Math.floor(fy * sy), inside, dot };
  }
  const coordOf = (p) => (S.brush === 'dot' ? [p.x, p.y] : [p.c, p.r]);
  const clampP = (p, sf) => [Math.max(0, Math.min(sf.w - 1, p[0])), Math.max(0, Math.min(sf.h - 1, p[1]))];

  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    const p = pointFromEvent(e);
    if (S.tool === 'pan') {
      drag = { pan: true, x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
      stage.classList.add('grabbing');
      cv.setPointerCapture(e.pointerId);
      return;
    }
    if (!p.inside) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    adjusting = false;
    if (S.tool === 'pick') {
      setChar(S.grid[p.r * S.cols + p.c] === '⠀' ? ' ' : S.grid[p.r * S.cols + p.c]);
      setBrush('char');
      setTool('pen');
      return;
    }
    if (S.tool === 'text') {
      pushUndo();
      cursor = { c: p.c, r: p.r, c0: p.c };
      drawOverlay();
      focusKbd();
      return;
    }
    const sf = surface(S.tool === 'erase');
    const pt = coordOf(p);
    pushUndo();
    if (S.tool === 'fill') { flood(sf, pt[0], pt[1]); return; }
    drag = { sf, start: pt, last: pt };
    if (S.tool === 'line' || S.tool === 'rect') {
      rec = new Map();
      sf.set(pt[0], pt[1], sf.ink);
    } else {
      sf.set(pt[0], pt[1], sf.ink);
    }
  });
  cv.addEventListener('pointermove', (e) => {
    const p = pointFromEvent(e);
    hover = p.inside ? p : null;
    if (drag && drag.pan) {
      stage.scrollLeft = drag.sl - (e.clientX - drag.x);
      stage.scrollTop = drag.st - (e.clientY - drag.y);
      return;
    }
    if (drag) {
      const cur = clampP(coordOf(p), drag.sf);
      if (S.tool === 'line' || S.tool === 'rect') {
        restorePreview();
        (S.tool === 'line' ? line : rectOutline)(drag.sf, drag.start[0], drag.start[1], cur[0], cur[1]);
      } else if (cur[0] !== drag.last[0] || cur[1] !== drag.last[1]) {
        line(drag.sf, drag.last[0], drag.last[1], cur[0], cur[1]);
      }
      drag.last = cur;
    }
    drawOverlay();
    updateStatus(p);
  });
  const endDrag = () => {
    if (drag && drag.pan) stage.classList.remove('grabbing');
    drag = null;
    rec = null;
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', () => { if (rec) restorePreview(); endDrag(); });
  cv.addEventListener('pointerleave', () => { hover = null; drawOverlay(); updateStatus(); });

  // ---------- Text ----------
  const kbd = $('#kbd');
  function focusKbd() {
    kbd.style.top = Math.max(0, Math.min(window.innerHeight - 40, cv.getBoundingClientRect().top + cursor.r * ch / dpr)) + 'px';
    kbd.focus({ preventScroll: true });
  }
  function typeChar(chr) {
    if (!cursor) return;
    if (chr === '\n' || chr === '\r') { newline(); return; }
    if (chr.length !== 1) return;
    setCell(cursor.r * S.cols + cursor.c, chr);
    cursor.c++;
    if (cursor.c >= S.cols) newline();
    drawOverlay();
  }
  function newline() {
    cursor.c = cursor.c0;
    cursor.r = Math.min(S.rows - 1, cursor.r + 1);
    drawOverlay();
  }
  kbd.addEventListener('input', () => {
    const v = kbd.value;
    kbd.value = '';
    for (const chr of v) typeChar(chr);
  });
  kbd.addEventListener('keydown', (e) => {
    if (!cursor) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z' || k === 'y')) return; // global
    if (k === 'Backspace') {
      e.preventDefault();
      if (cursor.c > 0) cursor.c--; else if (cursor.r > 0) { cursor.r--; cursor.c = S.cols - 1; }
      setCell(cursor.r * S.cols + cursor.c, ' ');
    } else if (k === 'Enter') { e.preventDefault(); newline(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); cursor.c = Math.max(0, cursor.c - 1); }
    else if (k === 'ArrowRight') { e.preventDefault(); cursor.c = Math.min(S.cols - 1, cursor.c + 1); }
    else if (k === 'ArrowUp') { e.preventDefault(); cursor.r = Math.max(0, cursor.r - 1); }
    else if (k === 'ArrowDown') { e.preventDefault(); cursor.r = Math.min(S.rows - 1, cursor.r + 1); }
    else if (k === 'Escape') { cursor = null; kbd.blur(); }
    drawOverlay();
  });

  // ---------- Bedienelemente ----------
  function setTool(t) {
    S.tool = t;
    $$('.tool[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
    stage.classList.toggle('pan', t === 'pan');
    stage.classList.toggle('text', t === 'text');
    if (t !== 'text') { cursor = null; kbd.blur(); }
    const hints = {
      pen: 'Ziehen zum Zeichnen', erase: 'Ziehen zum Radieren', line: 'Ziehen für eine Linie', rect: 'Ziehen für ein Rechteck',
      fill: 'Tippen füllt die Fläche', text: 'Tippen setzt den Cursor, dann schreiben', pick: 'Tippen übernimmt das Zeichen', pan: 'Ziehen verschiebt die Ansicht',
    };
    $('#stHint').textContent = hints[t] || '';
    drawOverlay();
    savePrefs();
  }
  function setBrush(b) {
    S.brush = b;
    $$('[data-brush]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.brush === b)));
    const [sx, sy] = gridOf(S.set);
    $('#brushNote').textContent = b === 'dot'
      ? `Punkt setzt einzelne Rasterpunkte im Zeichensatz ${SETS[S.set].name} (${sx} × ${sy} pro Zeichen).`
      : 'Zeichen setzt das gewählte Zeichen in ganze Zellen.';
    $('#chars').classList.toggle('off', b === 'dot');
    savePrefs();
  }
  function setChar(c) {
    if (!c) return;
    S.char = c;
    $$('#chars button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.c === c)));
    savePrefs();
  }
  function setSet(key) {
    S.set = key;
    $$('.set').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.set === key)));
    setBrush(S.brush);
    updateStatus();
    if (image) reconvert();
    savePrefs();
  }

  function buildSets() {
    const box = $('#sets');
    for (const [key, s] of Object.entries(SETS)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'set'; b.dataset.set = key; b.setAttribute('role', 'radio');
      b.innerHTML = `<b></b><i></i>`;
      b.querySelector('b').textContent = s.name;
      b.querySelector('i').textContent = s.sample;
      b.addEventListener('click', () => setSet(key));
      box.appendChild(b);
    }
  }
  const PALETTE = '█▓▒░▀▄▌▐▘▝▖▗▚▞#@%&*+=-_|/\\<>()[]{}.:,;\'"`^~oO0xX'.split('');
  function buildChars() {
    const box = $('#chars');
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.c = c; b.setAttribute('role', 'radio');
      b.title = `Zeichen ${c}`;
      if (QUAD_INDEX[c] !== undefined || SHADES[c]) {
        // Blockzeichen selbst zeichnen, damit sie unabhängig von der Schrift gleich aussehen
        const k = document.createElement('canvas');
        k.width = 16; k.height = 32;
        const g = k.getContext('2d');
        g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#fff';
        paintGlyph(g, c, 0, 0, 16, 32, g.fillStyle, makePats(g, 16, g.fillStyle));
        b.appendChild(k);
      } else b.textContent = c;
      b.addEventListener('click', () => { setChar(c); setBrush('char'); if (S.tool === 'erase' || S.tool === 'pick' || S.tool === 'pan') setTool('pen'); });
      box.appendChild(b);
    }
  }

  const PRESETS = [
    ['Nacht', '#e9ebfb', '#10112c'],
    ['Kobalt', '#ffffff', '#2424ff'],
    ['Papier', '#14152e', '#f1eee4'],
    ['Terminal', '#6dff8a', '#07110a'],
    ['Bernstein', '#ffb000', '#140c00'],
    ['Magenta', '#ff2e93', '#0e0718'],
  ];
  function buildPresets() {
    const box = $('#presets');
    PRESETS.forEach(([name, f, b]) => {
      const el = document.createElement('button');
      el.type = 'button'; el.title = name; el.setAttribute('role', 'radio'); el.setAttribute('aria-label', name);
      el.style.setProperty('--f', f); el.style.setProperty('--b', b);
      el.dataset.f = f; el.dataset.b = b;
      el.addEventListener('click', () => setColors(f, b));
      box.appendChild(el);
    });
  }
  function setColors(f, b) {
    const flipped = (lum(f) > lum(b)) !== (lum(S.fg) > lum(S.bg));
    S.fg = f; S.bg = b;
    $('#fg').value = f; $('#bg').value = b;
    $$('#presets button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.f === f && x.dataset.b === b)));
    redrawAll();
    if (flipped && image && adjusting) convert(); // helle und dunkle Tinte: Bild passend neu rechnen
    savePrefs();
  }

  function syncControls() {
    $('#imgCols').value = S.imgCols; $('#oCols').textContent = S.imgCols;
    $('#algo').value = S.algo;
    $('#bright').value = S.bright; $('#oBright').textContent = S.bright;
    $('#contrast').value = S.contrast; $('#oContrast').textContent = S.contrast;
    $('#gamma').value = Math.round(S.gamma * 100); $('#oGamma').textContent = S.gamma.toFixed(2);
    $('#invert').checked = S.invert;
    $('#pngScale').value = String(S.pngScale);
    $$('.set').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.set === S.set)));
  }
  function syncSizeInputs() { $('#cols').value = S.cols; $('#rows').value = S.rows; }

  function bindRange(id, out, fn) {
    const el = $('#' + id);
    el.addEventListener('input', () => { fn(Number(el.value)); if (out) $('#' + out).textContent = out === 'oGamma' ? S.gamma.toFixed(2) : el.value; reconvert(); savePrefs(); });
  }
  bindRange('imgCols', 'oCols', (v) => { S.imgCols = v; });
  bindRange('bright', 'oBright', (v) => { S.bright = v; });
  bindRange('contrast', 'oContrast', (v) => { S.contrast = v; });
  bindRange('gamma', 'oGamma', (v) => { S.gamma = v / 100; });
  $('#algo').addEventListener('change', (e) => { S.algo = e.target.value; reconvert(); savePrefs(); });
  $('#invert').addEventListener('change', (e) => { S.invert = e.target.checked; reconvert(); savePrefs(); });
  $('#file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  $('#demo').addEventListener('click', loadDemo);

  $$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $$('[data-brush]').forEach((b) => b.addEventListener('click', () => setBrush(b.dataset.brush)));
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#customChar').addEventListener('input', (e) => {
    const c = Array.from(e.target.value).find((x) => x.length === 1 && x.trim());
    if (c) { setChar(c); setBrush('char'); }
  });
  $('#fg').addEventListener('input', (e) => setColors(e.target.value, S.bg));
  $('#bg').addEventListener('input', (e) => setColors(S.fg, e.target.value));

  $('#resize').addEventListener('click', () => {
    const nc = Math.max(4, Math.min(MAX_COLS, parseInt($('#cols').value, 10) || S.cols));
    const nr = Math.max(2, Math.min(MAX_ROWS, parseInt($('#rows').value, 10) || S.rows));
    if (nc === S.cols && nr === S.rows) return;
    pushUndo();
    const g = blankGrid(nc * nr);
    for (let r = 0; r < Math.min(nr, S.rows); r++) for (let c = 0; c < Math.min(nc, S.cols); c++) g[r * nc + c] = S.grid[r * S.cols + c];
    S.cols = nc; S.rows = nr; S.grid = g; image = null; adjusting = false;
    $('#imgNote').textContent = 'Auch per Ziehen und Ablegen oder Einfügen (Strg+V).';
    layout(); syncSizeInputs(); scheduleSave();
  });
  $('#clear').addEventListener('click', () => {
    pushUndo();
    S.grid = blankGrid(S.cols * S.rows); image = null; adjusting = false;
    $('#imgNote').textContent = 'Leere Leinwand. Mit Zurück kommt das Bild wieder.';
    redrawAll(); scheduleSave();
  });

  // ---------- Zoom ----------
  function setZoom(z) {
    S.zoom = z;
    $('#zoomLabel').textContent = Math.round(z * 100) + ' %';
    layout();
    savePrefs();
  }
  function fitZoom() {
    const pad = window.innerWidth < 560 ? 28 : 52;
    const aw = stage.clientWidth - pad, ah = stage.clientHeight - pad;
    const narrow = window.innerWidth <= 860;
    let z = aw / (S.cols * BASE_W);
    if (!narrow) z = Math.min(z, (ah * 1.6) / (S.rows * BASE_H));
    // Auf ganze Gerätepixel pro Zelle runden, damit das Raster scharf bleibt
    const d = Math.min(window.devicePixelRatio || 1, 3);
    z = Math.max(ZOOMS[0], Math.min(4, Math.floor(z * BASE_W * d) / (BASE_W * d)));
    setZoom(z);
  }
  const stepZoom = (d) => {
    const next = d > 0 ? ZOOMS.find((z) => z > S.zoom + 1e-6) : ZOOMS.slice().reverse().find((z) => z < S.zoom - 1e-6);
    if (next) setZoom(next);
  };
  $('#zoomIn').addEventListener('click', () => stepZoom(1));
  $('#zoomOut').addEventListener('click', () => stepZoom(-1));
  $('#zoomFit').addEventListener('click', fitZoom);

  // ---------- Export ----------
  function asText() {
    const lines = [];
    for (let r = 0; r < S.rows; r++) lines.push(S.grid.slice(r * S.cols, (r + 1) * S.cols).join('').replace(/ +$/, ''));
    return lines.join('\n') + '\n';
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const stamp = () => 'dither-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  $('#copyTxt').addEventListener('click', async () => {
    const t = asText();
    try { await navigator.clipboard.writeText(t); toast('Text kopiert.'); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Text kopiert.'); } catch (_) { toast('Kopieren nicht möglich, nutze .txt.'); }
      ta.remove();
    }
  });
  $('#saveTxt').addEventListener('click', () => download(new Blob([asText()], { type: 'text/plain;charset=utf-8' }), stamp() + '.txt'));
  $('#pngScale').addEventListener('change', (e) => { S.pngScale = Number(e.target.value); savePrefs(); });
  $('#savePng').addEventListener('click', () => {
    let s = S.pngScale;
    while (s > 1 && S.cols * BASE_W * s * S.rows * BASE_H * s > 40e6) s /= 2;
    const w = BASE_W * s, h = BASE_H * s;
    const c = document.createElement('canvas');
    c.width = S.cols * w; c.height = S.rows * h;
    const g = c.getContext('2d');
    g.fillStyle = S.bg; g.fillRect(0, 0, c.width, c.height);
    const pc = makePats(g, w, S.fg);
    prepCtx(g, w);
    for (let r = 0, i = 0; r < S.rows; r++) for (let col = 0; col < S.cols; col++, i++) paintGlyph(g, S.grid[i], col * w, r * h, w, h, S.fg, pc);
    c.toBlob((b) => download(b, stamp() + '.png'), 'image/png');
  });
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function asSvg() {
    const W = S.cols * BASE_W, H = S.rows * BASE_H;
    let blocks = '', dots = '', shades = { '░': '', '▒': '', '▓': '' }, texts = '';
    for (let r = 0; r < S.rows; r++) {
      // Blockzeichen: pro Halbzeile zusammenhängende Läufe zu einem Pfad zusammenfassen
      for (let half = 0; half < 2; half++) {
        let run = -1;
        const flush = (end) => { if (run >= 0) { blocks += `M${run * 4} ${r * 16 + half * 8}h${(end - run) * 4}v8h-${(end - run) * 4}z`; run = -1; } };
        for (let qx = 0; qx < S.cols * 2; qx++) {
          const q = QUAD_INDEX[S.grid[r * S.cols + (qx >> 1)]];
          const bit = q === undefined ? 0 : (half === 0 ? (qx & 1 ? q & 4 : q & 8) : (qx & 1 ? q & 1 : q & 2));
          if (bit && run < 0) run = qx;
          if (!bit) flush(qx);
        }
        flush(S.cols * 2);
      }
      let tStart = -1, tStr = '';
      const flushText = () => {
        if (tStart >= 0) {
          texts += `<text x="${tStart * 8}" y="${r * 16 + 8.5}" textLength="${tStr.length * 8}" lengthAdjust="spacingAndGlyphs">${esc(tStr)}</text>`;
          tStart = -1; tStr = '';
        }
      };
      for (let c = 0; c < S.cols; c++) {
        const chr = S.grid[r * S.cols + c];
        const code = chr.charCodeAt(0);
        const isText = !isBlank(chr) && QUAD_INDEX[chr] === undefined && !SHADES[chr] && !(code >= 0x2800 && code <= 0x28ff);
        if (code > 0x2800 && code <= 0x28ff) {
          const m = brailleToMask(code - 0x2800);
          for (let b = 0; b < 8; b++) if (m & (1 << b)) dots += `M${c * 8 + (b & 1) * 4 + 0.56} ${r * 16 + (b >> 1) * 4 + 0.56}h2.88v2.88h-2.88z`;
        } else if (SHADES[chr]) shades[chr] += `M${c * 8} ${r * 16}h8v16h-8z`;
        if (isText) { if (tStart < 0) tStart = c; tStr += chr; } else flushText();
      }
      flushText();
    }
    const f = S.fg;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 2}" height="${H * 2}" shape-rendering="crispEdges">
<defs>
<pattern id="s1" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="${f}"/></pattern>
<pattern id="s2" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="${f}"/><rect x="1" y="1" width="1" height="1" fill="${f}"/></pattern>
<pattern id="s3" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="2" height="1" fill="${f}"/><rect x="1" y="1" width="1" height="1" fill="${f}"/></pattern>
</defs>
<rect width="${W}" height="${H}" fill="${S.bg}"/>
${blocks ? `<path fill="${f}" d="${blocks}"/>` : ''}
${dots ? `<path fill="${f}" d="${dots}"/>` : ''}
${shades['░'] ? `<path fill="url(#s1)" d="${shades['░']}"/>` : ''}
${shades['▒'] ? `<path fill="url(#s2)" d="${shades['▒']}"/>` : ''}
${shades['▓'] ? `<path fill="url(#s3)" d="${shades['▓']}"/>` : ''}
${texts ? `<g fill="${f}" font-family="IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace" font-size="13.3" dominant-baseline="central" xml:space="preserve">${texts}</g>` : ''}
</svg>
`;
  }
  $('#saveSvg').addEventListener('click', () => download(new Blob([asSvg()], { type: 'image/svg+xml' }), stamp() + '.svg'));

  // ---------- Status, Hinweise ----------
  function updateStatus(p) {
    $('#stSize').textContent = `${S.cols} × ${S.rows} Zeichen`;
    $('#stSet').textContent = SETS[S.set].name;
    $('#stPos').textContent = p && p.inside ? `Spalte ${p.c + 1}, Zeile ${p.r + 1}` : '–';
  }
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 1800);
  }

  // ---------- Tastatur, Einfügen, Ablegen ----------
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key === 'y') { e.preventDefault(); redo(); return; }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (mod || e.altKey) return;
    const map = { b: 'pen', e: 'erase', l: 'line', r: 'rect', f: 'fill', t: 'text', i: 'pick', h: 'pan' };
    const k = e.key.toLowerCase();
    if (map[k]) { setTool(map[k]); e.preventDefault(); }
    else if (k === '+' || k === '=') stepZoom(1);
    else if (k === '-') stepZoom(-1);
    else if (k === '0') fitZoom();
    else if (k === 'p') setBrush(S.brush === 'dot' ? 'char' : 'dot');
  });
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const img = items.find((it) => it.type.startsWith('image/'));
    if (img) { e.preventDefault(); loadFile(img.getAsFile()); }
  });
  let dragDepth = 0;
  const drop = $('#drop');
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { dragDepth++; drop.hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; drop.hidden = true;
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // ---------- Speichern im Browser ----------
  const KEY = 'dither-werkstatt-v1';
  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(KEY + ':grid', JSON.stringify({ cols: S.cols, rows: S.rows, grid: S.grid.join('') })); } catch (e) { /* voll oder gesperrt */ }
    }, 400);
  }
  function savePrefs() {
    try {
      const { set, tool, brush, char, fg, bg, zoom, imgCols, algo, bright, contrast, gamma, invert, pngScale } = S;
      localStorage.setItem(KEY + ':prefs', JSON.stringify({ set, tool, brush, char, fg, bg, zoom, imgCols, algo, bright, contrast, gamma, invert, pngScale }));
    } catch (e) { /* egal */ }
  }
  function loadSaved() {
    let ok = false;
    try {
      const p = JSON.parse(localStorage.getItem(KEY + ':prefs') || 'null');
      if (p) for (const k of Object.keys(p)) if (k in S && typeof p[k] === typeof S[k]) S[k] = p[k];
      if (!SETS[S.set]) S.set = 'braille';
      if (!(S.zoom >= ZOOMS[0] && S.zoom <= 4)) S.zoom = 1;
      const g = JSON.parse(localStorage.getItem(KEY + ':grid') || 'null');
      if (g && g.cols && g.rows && typeof g.grid === 'string' && g.grid.length === g.cols * g.rows) {
        S.cols = Math.min(MAX_COLS, g.cols); S.rows = Math.min(MAX_ROWS, g.rows);
        S.grid = g.grid.split('');
        if (S.grid.length !== S.cols * S.rows) S.grid = blankGrid(S.cols * S.rows);
        ok = true;
      }
    } catch (e) { ok = false; }
    return ok;
  }

  // ---------- Start ----------
  buildSets();
  buildChars();
  buildPresets();
  const restored = loadSaved();
  if (!restored) S.grid = blankGrid(S.cols * S.rows);
  syncControls();
  syncSizeInputs();
  setColors(S.fg, S.bg);
  setTool(S.tool === 'text' ? 'pen' : S.tool);
  setBrush(S.brush);
  setChar(S.char);
  $('#zoomLabel').textContent = Math.round(S.zoom * 100) + ' %';
  layout();
  updateHistoryButtons();
  if (restored) $('#imgNote').textContent = 'Deine letzte Zeichnung ist wieder da. Öffne ein Bild oder zeichne weiter.';
  else loadDemo();
  if (document.fonts && document.fonts.load) document.fonts.load('16px "Plex Mono"').then(() => redrawAll()).catch(() => {});
  let lastDpr = window.devicePixelRatio;
  window.addEventListener('resize', () => { if (window.devicePixelRatio !== lastDpr) { lastDpr = window.devicePixelRatio; layout(); } });
})();
