/* =========================================================
   뾰로롱 쇼츠 편집기  (1080×1920 · 30fps)
   - 컷(이미지+자막) 타임라인 / 나레이션 합성 / MP4·WebM 내보내기
   - 모든 처리는 브라우저 안에서만. 서버 전송 없음.
   ========================================================= */
'use strict';

/* ---------------- 상수 ---------------- */
const CW = 1080, CH = 1920;
const SAFE_TOP = 1210, SAFE_BOTTOM = 1440;
const SAFE_H = SAFE_BOTTOM - SAFE_TOP;
const TITLE_SIZE = 104, BODY_SIZE = 92, END_SIZE = 104;
const YELLOW = '#FFD600';
const RED = '#FF2E2E';
const WHITE = '#FFFFFF';
const FF = '"Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic","Nanum Gothic",system-ui,sans-serif';
const LS_KEY = 'ppyororong-editor:v1';
const DB_NAME = 'ppyororong-editor';
const DB_STORE = 'assets';
const MAX_IMG_SIDE = 1620;          // 업로드 이미지 자동 축소 기준

/* ---------------- 유틸 ---------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const stamp = () => { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; };
const num = (v, def) => { const n = parseFloat(v); return Number.isFinite(n) ? n : def; };

function toast(msg, ms = 2200) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* 전역 오류를 화면에도 보여 준다 (원인 파악용) */
window.addEventListener('error', (e) => {
  try { toast('오류: ' + (e.message || '스크립트 오류'), 6000); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { toast('오류: ' + ((e.reason && e.reason.message) || '처리되지 않은 작업'), 6000); } catch (_) {}
});

/* ---------------- 상태 ---------------- */
const cv = $('#cv');
const ctx = cv.getContext('2d', { alpha: false });

let state = defaultProject();
let selectedId = null;
let assets = new Map();          // key -> { dataUrl, img, blob, name }
let savedAssets = new Set();     // IndexedDB에 이미 저장된 key
let playhead = 0;                // 초
let playing = false;

let audioCtx = null;
let audioBuffer = null;
let audioBlob = null;
let audioMeta = { name: '', key: null, duration: 0, bytes: 0 };

function newCut(type, duration) {
  return {
    id: uid(),
    type,
    text: type === 'ending' ? '구독 누르시고\n오늘도 건강하세요 \u2665' : '',
    secondColor: 'yellow',
    duration: duration != null ? duration : (type === 'ending' ? 2.5 : 3),
    zoom: 1, offsetX: 0, offsetY: 0,
    imgKey: null,
  };
}

function defaultProject() {
  return {
    version: 1,
    settings: { safeZone: true, bodyScrim: true, volume: 1 },
    cuts: [newCut('intro', 3), newCut('body', 3), newCut('ending', 2.5)],
  };
}

function normalizeCut(c) {
  return {
    id: c.id || uid(),
    type: ['intro', 'body', 'ending'].includes(c.type) ? c.type : 'body',
    text: typeof c.text === 'string' ? c.text : '',
    secondColor: c.secondColor === 'white' ? 'white' : 'yellow',
    duration: clamp(num(c.duration, 3), 0.5, 30),
    zoom: clamp(num(c.zoom, 1), 1, 2.5),
    offsetX: clamp(num(c.offsetX, 0), -540, 540),
    offsetY: clamp(num(c.offsetY, 0), -960, 960),
    imgKey: c.imgKey || null,
  };
}

const cutDuration = (c) => clamp(num(c.duration, 3), 0.5, 30);
const totalDuration = () => state.cuts.reduce((a, c) => a + cutDuration(c), 0);
const startTime = (i) => state.cuts.slice(0, i).reduce((a, c) => a + cutDuration(c), 0);
const currentCut = () => state.cuts.find((c) => c.id === selectedId) || null;
const currentIndex = () => state.cuts.findIndex((c) => c.id === selectedId);

function cutAt(t) {
  if (!state.cuts.length) return null;
  let acc = 0;
  for (let i = 0; i < state.cuts.length; i++) {
    const d = cutDuration(state.cuts[i]);
    if (t < acc + d || i === state.cuts.length - 1) {
      return { cut: state.cuts[i], index: i, start: acc, local: Math.max(0, t - acc) };
    }
    acc += d;
  }
  return null;
}

/* ---------------- IndexedDB (이미지·오디오 보관) ---------------- */
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { rej(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbPromise;
}
async function idbPut(key, val) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(val, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return true;
  } catch (e) { console.warn('IDB put 실패', e); return false; }
}
async function idbGet(key) {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const r = tx.objectStore(DB_STORE).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } catch (e) { console.warn('IDB get 실패', e); return null; }
}
async function idbDel(key) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) { /* 무시 */ }
}
async function idbClear() {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) { /* 무시 */ }
}

/* ---------------- 파일 ↔ 데이터 ---------------- */
function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('이미지를 읽을 수 없습니다'));
    img.src = src;
  });
}
async function dataUrlToBlob(dataUrl) {
  const r = await fetch(dataUrl);
  return await r.blob();
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

/* 업로드 이미지: 너무 크면 축소해서 메모리·저장공간 절약 */
async function prepareImageFile(file) {
  const rawUrl = await readAsDataURL(file);
  let img = await loadImage(rawUrl);
  const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
  if (maxSide <= MAX_IMG_SIDE && file.size < 3 * 1024 * 1024) {
    return { dataUrl: rawUrl, img, blob: file, name: file.name };
  }
  const scale = Math.min(1, MAX_IMG_SIDE / maxSide);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.fillStyle = '#000'; cx.fillRect(0, 0, w, h);
  cx.drawImage(img, 0, 0, w, h);
  const dataUrl = c.toDataURL('image/jpeg', 0.92);
  img = await loadImage(dataUrl);
  const blob = await dataUrlToBlob(dataUrl);
  return { dataUrl, img, blob, name: file.name };
}

function download(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
}

/* ---------------- 폰트 ---------------- */
async function ensureFonts() {
  try {
    if (!document.fonts) return;
    await Promise.all([
      document.fonts.load('900 104px "Noto Sans KR"', '뾰로롱 건강 음식'),
      document.fonts.load('700 92px "Noto Sans KR"', '뾰로롱 건강 음식'),
      document.fonts.load('900 92px "Noto Sans KR"', '뾰로롱 건강 음식'),
    ]);
    await document.fonts.ready;
  } catch (e) { console.warn('폰트 로드', e); }
}

/* =========================================================
   렌더링
   ========================================================= */
function setFont(c, size, weight = 900) {
  c.font = `${weight} ${size}px ${FF}`;
}

/* 한 줄을 maxW에 맞춰 자동 줄바꿈 (공백 우선, 없으면 글자 단위) */
function wrapText(c, text, maxW, size) {
  setFont(c, size, 900);
  const out = [];
  const raws = String(text).split('\n');
  for (const raw of raws) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { out.push(''); continue; }
    if (c.measureText(line).width <= maxW) { out.push(line); continue; }
    let buf = '';
    const tokens = line.split(' ');
    for (let ti = 0; ti < tokens.length; ti++) {
      const word = tokens[ti] + (ti < tokens.length - 1 ? ' ' : '');
      if (c.measureText(buf + word).width <= maxW) { buf += word; continue; }
      if (buf.trim()) { out.push(buf.trim()); buf = ''; }
      if (c.measureText(word).width <= maxW) { buf = word; continue; }
      for (const ch of word) {
        if (c.measureText(buf + ch).width > maxW && buf) { out.push(buf); buf = ch; }
        else buf += ch;
      }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

function strokeWidth(size) { return Math.max(7, Math.round(size * 0.135)); }

function paintLine(c, text, x, y, size, color, align = 'center') {
  setFont(c, size, 900);
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  c.miterLimit = 2;
  c.lineWidth = strokeWidth(size);
  c.strokeStyle = '#000000';
  c.strokeText(text, x, y);
  c.fillStyle = color;
  c.fillText(text, x, y);
}

/* ♥ 같은 일부 글자만 색을 바꿔 한 줄 그리기 */
function paintSegments(c, segments, cx, y, size) {
  setFont(c, size, 900);
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  c.miterLimit = 2;
  const widths = segments.map((s) => c.measureText(s.text).width);
  const total = widths.reduce((a, b) => a + b, 0);
  let x = cx - total / 2;
  // 1) 외곽선 먼저 전부
  c.lineWidth = strokeWidth(size);
  c.strokeStyle = '#000000';
  segments.forEach((s, i) => { c.strokeText(s.text, x, y); x += widths[i]; });
  // 2) 색 채우기
  x = cx - total / 2;
  segments.forEach((s, i) => { c.fillStyle = s.color; c.fillText(s.text, x, y); x += widths[i]; });
}

/* 이미지 cover 배치 (1080×1920 중앙 크롭 + 확대/이동) */
function drawCover(c, img, cut) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const base = Math.max(CW / iw, CH / ih);
  const s = base * clamp(num(cut.zoom, 1), 1, 2.5);
  const w = iw * s, h = ih * s;
  const x = (CW - w) / 2 + num(cut.offsetX, 0);
  const y = (CH - h) / 2 + num(cut.offsetY, 0);
  c.drawImage(img, x, y, w, h);
}

function drawEmptyImage(c, index, preview) {
  const g = c.createLinearGradient(0, 0, 0, CH);
  g.addColorStop(0, '#243044');
  g.addColorStop(0.5, '#161d29');
  g.addColorStop(1, '#0c1118');
  c.fillStyle = g;
  c.fillRect(0, 0, CW, CH);
  if (!preview) return;
  c.save();
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = 'rgba(255,255,255,.30)';
  c.font = `900 150px ${FF}`;
  c.fillText('🖼️', CW / 2, 800);
  c.font = `700 46px ${FF}`;
  c.fillStyle = 'rgba(255,255,255,.42)';
  c.fillText(`컷 ${index + 1} · 이미지 없음`, CW / 2, 960);
  c.font = `700 32px ${FF}`;
  c.fillStyle = 'rgba(255,255,255,.26)';
  c.fillText('오른쪽 패널에서 이미지를 올려 주세요', CW / 2, 1024);
  c.restore();
}

/* 첫 화면: 상단 스크림 + 중앙 상단 대형 타이틀 */
function drawIntro(c, cut, preview) {
  const g = c.createLinearGradient(0, 0, 0, 1000);
  g.addColorStop(0, 'rgba(0,0,0,0.78)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.40)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, CW, 1000);

  const text = (cut.text || '').trim();
  if (!text) {
    if (preview) {
      c.save();
      c.globalAlpha = .55;
      paintLine(c, '제목을 입력하세요', CW / 2, 470, TITLE_SIZE, WHITE);
      c.restore();
    }
    return;
  }
  const lines = wrapText(c, text, 960, TITLE_SIZE).slice(0, 4);
  const lh = Math.round(TITLE_SIZE * 1.2);
  let y = 430;
  lines.forEach((ln, i) => {
    paintLine(c, ln, CW / 2, y, TITLE_SIZE, i === 0 ? WHITE : YELLOW);
    y += lh;
  });
}

/* 본문: 하단 안전지대 안의 짧은 자막 */
function drawBody(c, cut, preview) {
  if (state.settings.bodyScrim) {
    const g = c.createLinearGradient(0, SAFE_TOP - 330, 0, SAFE_BOTTOM + 210);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.34)');
    g.addColorStop(0.8, 'rgba(0,0,0,0.52)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, SAFE_TOP - 330, CW, SAFE_H + 540);
  }

  const text = (cut.text || '').trim();
  if (!text) {
    if (preview) {
      c.save();
      c.globalAlpha = .5;
      paintLine(c, '자막을 입력하세요', CW / 2, SAFE_TOP + SAFE_H / 2, BODY_SIZE * .8, WHITE);
      c.restore();
    }
    return;
  }
  const lines = wrapText(c, text, 940, BODY_SIZE);
  const lh = Math.min(Math.round(BODY_SIZE * 1.2), Math.floor((SAFE_H - 14) / Math.max(1, lines.length)));
  const blockH = lh * lines.length;
  let y = SAFE_TOP + (SAFE_H - blockH) / 2 + lh / 2;
  lines.forEach((ln, i) => {
    const color = i === 0 ? WHITE : (cut.secondColor === 'white' ? WHITE : YELLOW);
    paintLine(c, ln, CW / 2, y, BODY_SIZE, color);
    y += lh;
  });
}

/* 엔딩: 화면 중앙, ♥만 빨강 */
function drawEnding(c, cut, preview) {
  c.fillStyle = 'rgba(0,0,0,0.26)';
  c.fillRect(0, 0, CW, CH);

  const text = (cut.text || '').trim() || '구독 누르시고\n오늘도 건강하세요 \u2665';
  const lines = wrapText(c, text, 960, END_SIZE);
  const lh = Math.round(END_SIZE * 1.25);
  let y = CH / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((ln) => {
    if (ln.includes('\u2665')) {
      const parts = ln.split(/(\u2665)/);
      const segs = parts
        .map((p) => ({ text: p, color: p === '\u2665' ? RED : WHITE }))
        .filter((s) => s.text.length);
      paintSegments(c, segs, CW / 2, y, END_SIZE);
    } else {
      paintLine(c, ln, CW / 2, y, END_SIZE, WHITE);
    }
    y += lh;
  });
}

/* 유튜브 하단 UI 안전지대 가이드 */
function drawSafeZone(c) {
  c.save();
  c.fillStyle = 'rgba(255,214,0,0.10)';
  c.fillRect(0, SAFE_TOP, CW, SAFE_H);
  c.strokeStyle = 'rgba(255,214,0,0.92)';
  c.lineWidth = 4;
  c.setLineDash([20, 14]);
  c.beginPath();
  c.moveTo(0, SAFE_TOP); c.lineTo(CW, SAFE_TOP);
  c.moveTo(0, SAFE_BOTTOM); c.lineTo(CW, SAFE_BOTTOM);
  c.stroke();
  c.setLineDash([]);
  c.font = `700 34px ${FF}`;
  c.textAlign = 'left';
  c.textBaseline = 'bottom';
  c.fillStyle = 'rgba(255,214,0,.95)';
  c.fillText('유튜브 UI 안전지대  y 1210 – 1440', 26, SAFE_TOP - 14);
  c.restore();
}

/* 전체 프레임 그리기. preview=false → 가이드/placeholder 없이 저장용 */
function render(t, opts = {}) {
  const preview = opts.preview !== false;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CW, CH);

  const found = cutAt(t);
  if (found) {
    const { cut, index } = found;
    const asset = cut.imgKey ? assets.get(cut.imgKey) : null;
    if (asset && asset.img) drawCover(ctx, asset.img, cut);
    else drawEmptyImage(ctx, index, preview);

    if (cut.type === 'intro') drawIntro(ctx, cut, preview);
    else if (cut.type === 'ending') drawEnding(ctx, cut, preview);
    else drawBody(ctx, cut, preview);
  }

  if (preview && state.settings.safeZone) drawSafeZone(ctx);
  ctx.restore();
}

/* =========================================================
   재생 / 오디오
   ========================================================= */
function getAC() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  return audioCtx;
}

let playRaf = 0, playStartCtx = 0, playStartT = 0;
let playSrc = null, playGain = null;
let lastUiTick = 0;

function stopPlayback() {
  if (playRaf) cancelAnimationFrame(playRaf);
  playRaf = 0;
  if (playSrc) { try { playSrc.stop(); } catch (e) {} try { playSrc.disconnect(); } catch (e) {} playSrc = null; }
  if (playGain) { try { playGain.disconnect(); } catch (e) {} playGain = null; }
}

function pausePlayback() {
  if (!playing) return;
  playing = false;
  stopPlayback();
  $('#btnPlay').textContent = '▶ 재생';
}

async function startPlayback() {
  if (playing) return;
  const total = totalDuration();
  if (total <= 0) { toast('컷이 없습니다.'); return; }
  if (playhead >= total - 0.02) playhead = 0;

  const acx = getAC();
  if (acx.state === 'suspended') { try { await acx.resume(); } catch (e) {} }

  playing = true;
  playStartT = playhead;
  playStartCtx = acx.currentTime + 0.08;

  if (audioBuffer) {
    stopPlayback();
    const src = acx.createBufferSource();
    src.buffer = audioBuffer;
    const gain = acx.createGain();
    gain.gain.value = clamp(state.settings.volume, 0, 1);
    src.connect(gain);
    gain.connect(acx.destination);
    const offset = Math.min(playStartT, Math.max(0, audioBuffer.duration - 0.02));
    try { src.start(playStartCtx, offset); } catch (e) { console.warn(e); }
    playSrc = src; playGain = gain;
  }

  $('#btnPlay').textContent = '❚❚ 정지';
  playRaf = requestAnimationFrame(playTick);
}

function playTick() {
  const acx = getAC();
  const total = totalDuration();
  const t = playStartT + Math.max(0, acx.currentTime - playStartCtx);
  if (t >= total) {
    playhead = total;
    render(playhead);
    playing = false;
    stopPlayback();
    $('#btnPlay').textContent = '▶ 재생';
    updateTransport();
    return;
  }
  playhead = t;
  render(playhead);
  const now = performance.now();
  if (now - lastUiTick > 90) { lastUiTick = now; updateTransport(); }
  playRaf = requestAnimationFrame(playTick);
}

/* =========================================================
   UI 동기화
   ========================================================= */
const TYPE_LABEL = { intro: '첫화면', body: '본문', ending: '엔딩' };
const TYPE_HINT = {
  intro: '상단 어두운 그라데이션 위, 중앙 상단 대형 타이틀 (104px · 1줄 흰색 / 2줄부터 노랑)',
  body: '상단 타이틀 없이 하단 안전지대(y 1210–1440) 안의 짧은 자막 (92px)',
  ending: '화면 중앙 엔딩 문구 — ♥만 빨강',
};

function setSaveStatus(text) { $('#saveStatus').textContent = text; }

function syncAll() {
  if (!currentCut()) selectedId = state.cuts[0] ? state.cuts[0].id : null;
  renderCutList();
  renderEditor();
  renderTimeline();
  updateTransport();
  render(playhead);
}

function firstLine(text, max = 34) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function renderCutList() {
  const list = $('#cutList');
  list.innerHTML = '';
  $('#cutCount').textContent = `(${state.cuts.length}컷)`;
  $('#totalDur').textContent = totalDuration().toFixed(1) + '초';

  state.cuts.forEach((cut, i) => {
    const item = document.createElement('div');
    item.className = 'cut-item' + (cut.id === selectedId ? ' sel' : '');
    item.dataset.id = cut.id;

    const asset = cut.imgKey ? assets.get(cut.imgKey) : null;
    const thumb = document.createElement('div');
    thumb.className = 'cut-thumb';
    if (asset) thumb.style.backgroundImage = `url("${asset.dataUrl}")`;
    else thumb.textContent = { intro: '🎬', body: '🖼️', ending: '🎵' }[cut.type];

    const main = document.createElement('div');
    main.className = 'cut-main';
    main.innerHTML = `
      <div class="cut-line">
        <span class="cut-idx">#${i + 1}</span>
        <span class="badge ${cut.type}">${TYPE_LABEL[cut.type]}</span>
      </div>
      <div class="cut-preview">${escapeHtml(firstLine(cut.text))}</div>
      <div class="cut-dur-wrap">
        <input class="cut-dur" type="number" min="0.5" max="30" step="0.1" value="${cutDuration(cut)}" aria-label="길이(초)" />초
      </div>`;

    const actions = document.createElement('div');
    actions.className = 'cut-actions';
    actions.innerHTML = `
      <button data-act="up" title="위로">▲</button>
      <button data-act="down" title="아래로">▼</button>
      <button data-act="dup" title="복제">복제</button>
      <button data-act="del" class="del" title="삭제">삭제</button>`;

    item.appendChild(thumb);
    item.appendChild(main);
    item.appendChild(actions);

    item.addEventListener('click', (ev) => {
      if (ev.target.closest('.cut-actions') || ev.target.closest('.cut-dur')) return;
      selectCut(cut.id, true);
    });

    main.querySelector('.cut-dur').addEventListener('change', (ev) => {
      cut.duration = clamp(num(ev.target.value, 3), 0.5, 30);
      ev.target.value = cutDuration(cut);
      renderTimeline(); updateTransport(); render(playhead); scheduleSave();
    });
    main.querySelector('.cut-dur').addEventListener('click', (ev) => ev.stopPropagation());

    actions.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      ev.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'up') moveCut(i, -1);
      else if (act === 'down') moveCut(i, 1);
      else if (act === 'dup') duplicateCut(cut.id);
      else if (act === 'del') deleteCut(cut.id);
    });

    list.appendChild(item);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function renderTimeline() {
  const tl = $('#timeline');
  tl.innerHTML = '';
  const total = totalDuration() || 1;
  state.cuts.forEach((cut, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tl-block' + (cut.id === selectedId ? ' sel' : '');
    b.style.flexGrow = String(cutDuration(cut) / total * 10);
    b.style.flexBasis = '0';
    b.innerHTML = `<span>${i + 1}</span><em>${cutDuration(cut).toFixed(1)}s</em>`;
    b.title = `${i + 1}번째 · ${TYPE_LABEL[cut.type]} · ${cutDuration(cut).toFixed(1)}초`;
    b.addEventListener('click', () => {
      pausePlayback();
      selectedId = cut.id;
      playhead = startTime(i) + 0.001;
      syncAll();
    });
    tl.appendChild(b);
  });
  markActiveBlock();
}

function markActiveBlock() {
  const idx = cutAt(playhead) ? cutAt(playhead).index : -1;
  $$('#timeline .tl-block').forEach((el, i) => el.classList.toggle('active', i === idx));
}

function updateTransport() {
  const total = totalDuration();
  $('#timeLabel').textContent = `${playhead.toFixed(1)} / ${total.toFixed(1)}s`;
  const scrub = $('#scrub');
  const v = total > 0 ? Math.round((playhead / total) * 1000) : 0;
  if (document.activeElement !== scrub) scrub.value = String(clamp(v, 0, 1000));
  $('#totalDur').textContent = total.toFixed(1) + '초';
  markActiveBlock();
}

function renderEditor() {
  const cut = currentCut();
  const idx = currentIndex();
  $('#editorEmpty').classList.toggle('hidden', !!cut);
  $('#editor').classList.toggle('hidden', !cut);
  if (!cut) { $('#editorTitle').textContent = ''; return; }

  $('#editorTitle').textContent = `${idx + 1}번째 컷 · ${cutDuration(cut).toFixed(1)}초`;
  $('#typeHint').textContent = TYPE_HINT[cut.type];

  $$('#typeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.type === cut.type));
  $('#secondColorField').classList.toggle('hidden', cut.type !== 'body');
  $('#endingPresetField').classList.toggle('hidden', cut.type !== 'ending');
  $$('#secondColorSeg button').forEach((b) => b.classList.toggle('on', b.dataset.color === cut.secondColor));

  const ta = $('#cutText');
  if (document.activeElement !== ta) ta.value = cut.text || '';
  ta.placeholder = cut.type === 'ending'
    ? '구독 누르시고\n오늘도 건강하세요 ♥'
    : (cut.type === 'intro' ? '예) 겨울철 면역에 좋은\n음식 TOP 5' : '예) 마늘은 하루 1~2쪽');

  $('#zoom').value = String(Math.round(cut.zoom * 100));
  $('#zoomVal').textContent = Math.round(cut.zoom * 100) + '%';
  $('#offX').value = String(Math.round(cut.offsetX));
  $('#offXVal').textContent = String(Math.round(cut.offsetX));
  $('#offY').value = String(Math.round(cut.offsetY));
  $('#offYVal').textContent = String(Math.round(cut.offsetY));
  $('#cutDur').value = String(cutDuration(cut));
  $('#btnClearImg').disabled = !cut.imgKey;
}

function selectCut(id, scroll = false) {
  selectedId = id;
  if (scroll) {
    const i = currentIndex();
    if (i >= 0) { playhead = startTime(i) + 0.001; }
  }
  renderCutList();
  renderEditor();
  renderTimeline();
  render(playhead);
  updateTransport();
}

/* =========================================================
   컷 편집 동작
   ========================================================= */
function addCut(type) {
  const cut = newCut(type);
  const i = currentIndex();
  if (type === 'ending') state.cuts.push(cut);
  else if (i >= 0) state.cuts.splice(i + 1, 0, cut);
  else state.cuts.push(cut);
  selectedId = cut.id;
  playhead = startTime(state.cuts.indexOf(cut)) + 0.001;
  syncAll(); scheduleSave();
}

function duplicateCut(id) {
  const i = state.cuts.findIndex((c) => c.id === id);
  if (i < 0) return;
  const src = state.cuts[i];
  const copy = { ...src, id: uid() };
  if (src.imgKey && assets.has(src.imgKey)) {
    const key = uid();
    assets.set(key, { ...assets.get(src.imgKey) });
    copy.imgKey = key;
  }
  state.cuts.splice(i + 1, 0, copy);
  selectedId = copy.id;
  syncAll(); scheduleSave();
  toast('컷을 복제했습니다');
}

function deleteCut(id) {
  if (state.cuts.length <= 1) { toast('컷이 최소 1개는 있어야 합니다.'); return; }
  const i = state.cuts.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [removed] = state.cuts.splice(i, 1);
  if (removed.imgKey && !state.cuts.some((c) => c.imgKey === removed.imgKey)) {
    assets.delete(removed.imgKey);
    savedAssets.delete(removed.imgKey);
    idbDel(removed.imgKey);
  }
  selectedId = (state.cuts[i] || state.cuts[i - 1] || state.cuts[0]).id;
  playhead = clamp(playhead, 0, Math.max(0, totalDuration() - 0.01));
  syncAll(); scheduleSave();
}

function moveCut(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.cuts.length) return;
  const [c] = state.cuts.splice(i, 1);
  state.cuts.splice(j, 0, c);
  syncAll(); scheduleSave();
}

/* 여러 이미지를 현재 컷부터 차례로 채움 */
async function applyImages(files) {
  let base = currentCut() || state.cuts[0];
  if (!base) return;
  let idx = state.cuts.indexOf(base);
  let added = 0, applied = 0;
  const imgs = files.filter((f) => f.type.startsWith('image/'));

  for (let fi = 0; fi < imgs.length; fi++) {
    const file = imgs[fi];
    try {
      const prepared = await prepareImageFile(file);
      const key = uid();
      assets.set(key, { dataUrl: prepared.dataUrl, img: prepared.img, blob: prepared.blob, name: prepared.name });
      savedAssets.delete(key);

      const target = state.cuts[idx];
      if (!target) break;
      const oldKey = target.imgKey;
      target.imgKey = key;
      applied++;
      if (oldKey && !state.cuts.some((c) => c.imgKey === oldKey)) {
        assets.delete(oldKey); savedAssets.delete(oldKey); idbDel(oldKey);
      }

      idx++;
      // 아직 넣을 이미지가 남았는데 컷이 모자라면 본문 컷 추가 (엔딩 앞)
      if (idx >= state.cuts.length && fi < imgs.length - 1) {
        const nc = newCut('body');
        const lastCut = state.cuts[state.cuts.length - 1];
        if (lastCut && lastCut.type === 'ending') state.cuts.splice(state.cuts.length - 1, 0, nc);
        else state.cuts.push(nc);
        added++;
      }
    } catch (e) {
      console.warn(e);
      toast(`이미지 1장을 읽지 못했습니다: ${file.name}`);
    }
  }
  if (!applied) return;
  selectedId = state.cuts[Math.min(idx - 1, state.cuts.length - 1)].id;
  syncAll(); scheduleSave();
  toast(`${applied}장 적용${added ? ` · 본문 컷 ${added}개 추가` : ''}`);
}

/* =========================================================
   저장 / 불러오기
   ========================================================= */
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveStatus('저장 중…');
  saveTimer = setTimeout(() => { saveNow(); }, 650);
}

async function saveNow() {
  try {
    const meta = {
      version: state.version,
      savedAt: Date.now(),
      settings: state.settings,
      cuts: state.cuts.map((c) => ({ ...c })),
      audio: { ...audioMeta },
    };
    try { localStorage.setItem(LS_KEY, JSON.stringify(meta)); }
    catch (e) { console.warn('localStorage', e); }

    for (const [key, val] of assets) {
      if (savedAssets.has(key)) continue;
      const blob = val.blob || await dataUrlToBlob(val.dataUrl);
      if (await idbPut(key, blob)) savedAssets.add(key);
    }
    if (audioMeta.key && audioBlob && !savedAssets.has(audioMeta.key)) {
      if (await idbPut(audioMeta.key, audioBlob)) savedAssets.add(audioMeta.key);
    }
    setSaveStatus('자동 저장 ' + hhmm());
  } catch (e) {
    console.error(e);
    setSaveStatus('저장 실패: ' + e.message);
  }
}

function projectPayload() {
  const assetMap = {};
  for (const [key, val] of assets) assetMap[key] = val.dataUrl;
  return {
    app: 'ppyororong-editor',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    cuts: state.cuts,
    audio: audioMeta,
    audioData: null,
    assets: assetMap,
  };
}

async function exportProjectJSON() {
  const payload = projectPayload();
  if (audioBlob) payload.audioData = await blobToDataURL(audioBlob);
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  download(blob, `뾰로롱_프로젝트_${stamp()}.json`);
  toast(`프로젝트를 저장했습니다 (${(blob.size / 1048576).toFixed(1)}MB)`);
}

async function importProjectJSON(file) {
  try {
    const text = await file.text();
    const p = JSON.parse(text);
    if (!p || !Array.isArray(p.cuts) || !p.cuts.length) throw new Error('컷 정보가 없습니다');

    // 자산 복원
    const nextAssets = new Map();
    for (const [key, dataUrl] of Object.entries(p.assets || {})) {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) continue;
      try {
        const img = await loadImage(dataUrl);
        const blob = await dataUrlToBlob(dataUrl);
        nextAssets.set(key, { dataUrl, img, blob, name: '' });
      } catch (e) { console.warn('asset', key, e); }
    }
    assets = nextAssets;
    savedAssets = new Set();
    state.cuts = p.cuts.map(normalizeCut);
    state.cuts.forEach((c) => { if (c.imgKey && !assets.has(c.imgKey)) c.imgKey = null; });
    state.settings = { ...defaultProject().settings, ...(p.settings || {}) };
    syncSettingsUI();

    // 오디오
    audioBuffer = null; audioBlob = null;
    audioMeta = { name: '', key: null, duration: 0, bytes: 0 };
    if (p.audioData && typeof p.audioData === 'string') {
      const blob = await (await fetch(p.audioData)).blob();
      await loadAudioBlob(blob, (p.audio && p.audio.name) || 'audio');
    }
    updateAudioInfo();

    selectedId = state.cuts[0].id;
    playhead = 0;
    syncAll(); scheduleSave();
    toast('프로젝트를 불러왔습니다');
  } catch (e) {
    console.error(e);
    toast('불러오기 실패: ' + e.message, 3600);
  }
}

function syncSettingsUI() {
  $('#safeZone').checked = !!state.settings.safeZone;
  $('#bodyScrim').checked = !!state.settings.bodyScrim;
  $('#volume').value = String(Math.round(clamp(num(state.settings.volume, 1), 0, 1) * 100));
  $('#volVal').textContent = $('#volume').value + '%';
}

async function boot() {
  await ensureFonts();
  let loaded = false;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.cuts) && p.cuts.length) {
        state.cuts = p.cuts.map(normalizeCut);
        state.settings = { ...defaultProject().settings, ...(p.settings || {}) };
        audioMeta = p.audio && p.audio.key
          ? { name: p.audio.name || 'audio', key: p.audio.key, duration: num(p.audio.duration, 0), bytes: num(p.audio.bytes, 0) }
          : { name: '', key: null, duration: 0, bytes: 0 };

        for (const cut of state.cuts) {
          if (!cut.imgKey) continue;
          if (assets.has(cut.imgKey)) continue;
          const blob = await idbGet(cut.imgKey);
          if (blob) {
            const dataUrl = await blobToDataURL(blob);
            const img = await loadImage(dataUrl);
            assets.set(cut.imgKey, { dataUrl, img, blob, name: '' });
            savedAssets.add(cut.imgKey);
          } else {
            cut.imgKey = null;
          }
        }
        if (audioMeta.key) {
          const blob = await idbGet(audioMeta.key);
          if (blob) { await loadAudioBlob(blob, audioMeta.name); savedAssets.add(audioMeta.key); }
          else audioMeta = { name: '', key: null, duration: 0, bytes: 0 };
        }
        loaded = true;
      }
    }
  } catch (e) {
    console.warn('복원 실패', e);
  }

  if (!loaded) state = defaultProject();
  syncSettingsUI();
  selectedId = state.cuts[0] ? state.cuts[0].id : null;
  syncAll();
  updateAudioInfo();
  setSaveStatus(loaded ? '이전 작업 복원됨' : '새 프로젝트');
  if (loaded) toast('이전 작업을 불러왔습니다');
}

/* =========================================================
   오디오
   ========================================================= */
async function loadAudioBlob(blob, name) {
  const acx = getAC();
  if (acx.state === 'suspended') { try { await acx.resume(); } catch (e) {} }
  const buf = await blob.arrayBuffer();
  const decoded = await acx.decodeAudioData(buf.slice(0));
  audioBuffer = decoded;
  audioBlob = blob;
  audioMeta = {
    name: name || 'audio',
    key: audioMeta.key || uid(),
    duration: decoded.duration,
    bytes: blob.size,
  };
  updateAudioInfo();
}

function updateAudioInfo() {
  const el = $('#audioInfo');
  if (audioBuffer) {
    el.innerHTML = `✅ <strong>${escapeHtml(audioMeta.name)}</strong> · ${audioMeta.duration.toFixed(1)}초 · ${(audioMeta.bytes / 1048576).toFixed(1)}MB<br>영상 길이 ${totalDuration().toFixed(1)}초`;
  } else {
    el.textContent = 'MP3 · WAV · M4A · AAC. 재생 미리보기와 영상 내보내기에 함께 쓰입니다.';
  }
}

async function applyAudioFile(file) {
  if (!file) return;
  try {
    toast('오디오를 읽는 중…', 4000);
    if (audioMeta.key) { savedAssets.delete(audioMeta.key); idbDel(audioMeta.key); }
    audioMeta = { name: '', key: null, duration: 0, bytes: 0 };
    await loadAudioBlob(file, file.name);
    scheduleSave();
    toast(`오디오 ${audioMeta.duration.toFixed(1)}초를 불러왔습니다`);
  } catch (e) {
    console.error(e);
    toast('오디오를 읽지 못했습니다. MP3/WAV/M4A 파일인지 확인해 주세요.', 3600);
  }
}

/* =========================================================
   내보내기
   ========================================================= */
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const cands = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of cands) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (e) {}
  }
  return '';
}

let exportJob = null;

function showProgress(ratio, label) {
  $('#progressWrap').classList.remove('hidden');
  $('#progressBar').style.width = Math.round(clamp(ratio, 0, 1) * 100) + '%';
  $('#progressText').textContent = label || (Math.round(clamp(ratio, 0, 1) * 100) + '%');
}
function hideProgress() { $('#progressWrap').classList.add('hidden'); }

function setExportUI(active) {
  const b = $('#btnExportVideo');
  b.textContent = active ? '■ 녹화 중지' : '🎬 영상 저장 (MP4 / WebM)';
  b.classList.toggle('danger', active);
  b.classList.toggle('primary', !active);
}

async function exportVideo() {
  if (exportJob) { // 취소
    exportJob.cancel = true;
    return;
  }
  pausePlayback();

  if (typeof MediaRecorder === 'undefined' || !cv.captureStream) {
    toast('이 브라우저는 영상 녹화를 지원하지 않습니다. PC는 최신 크롬/엣지, 아이폰은 iOS 16.4 이상 사파리를 써 주세요.', 5000);
    return;
  }

  await ensureFonts();
  const total = totalDuration();
  if (total < 0.5) { toast('컷 길이를 확인해 주세요.'); return; }

  const acx = getAC();
  if (acx.state === 'suspended') { try { await acx.resume(); } catch (e) {} }

  const vstream = cv.captureStream(30);
  const tracks = vstream.getVideoTracks().slice();
  let dest = null, src = null, gain = null;

  if (audioBuffer) {
    dest = acx.createMediaStreamDestination();
    src = acx.createBufferSource();
    src.buffer = audioBuffer;
    gain = acx.createGain();
    gain.gain.value = clamp(num(state.settings.volume, 1), 0, 1);
    src.connect(gain);
    gain.connect(dest);
    gain.connect(acx.destination);   // 녹화 중에도 소리 확인 가능
    dest.stream.getAudioTracks().forEach((t) => tracks.push(t));
  }

  const mime = pickMime();
  const stream = new MediaStream(tracks);
  const options = { videoBitsPerSecond: 12000000, audioBitsPerSecond: 128000 };
  if (mime) options.mimeType = mime;

  let rec;
  try {
    rec = new MediaRecorder(stream, options);
  } catch (e) {
    try { rec = new MediaRecorder(stream); }
    catch (e2) {
      toast('녹화를 시작할 수 없습니다: ' + e2.message, 5000);
      try { tracks.forEach((t) => t.stop()); } catch (err) {}
      return;
    }
  }

  const job = { cancel: false, rec, src, gain, dest, vstream, chunks: [], raf: 0 };
  exportJob = job;
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) job.chunks.push(ev.data); };
  rec.onerror = (ev) => { console.warn('rec error', ev); };

  setExportUI(true);
  $('#btnExportVideo').disabled = false;
  showProgress(0, '준비 중…');
  render(0, { preview: false });
  setSaveStatus('녹화 중… 탭을 닫지 마세요');
  await sleep(200);

  const t0 = acx.currentTime + 0.12;
  try { rec.start(250); } catch (e) { toast('녹화 시작 실패: ' + e.message, 5000); cleanupExport(job); return; }
  if (src) { try { src.start(t0, 0); } catch (e) { console.warn(e); } }

  const cleanupTracks = () => {
    try { if (src) src.stop(); } catch (e) {}
    try { if (src) src.disconnect(); } catch (e) {}
    try { if (gain) gain.disconnect(); } catch (e) {}
    try { if (dest) dest.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    job.vstream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
  };

  const finish = () => {
    render(Math.max(0, total - 0.05), { preview: false });
    showProgress(1, '마무리 중…');
    rec.onstop = () => {
      const type = rec.mimeType || mime || 'video/webm';
      const blob = new Blob(job.chunks, { type: type.split(';')[0] || 'video/webm' });
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      if (job.cancel) {
        toast('녹화를 취소했습니다.');
      } else if (!blob.size) {
        toast('녹화된 데이터가 없습니다. 다시 시도해 주세요.', 4000);
      } else {
        download(blob, `뾰로롱_${stamp()}.${ext}`);
        toast(`저장 완료 · ${ext.toUpperCase()} ${(blob.size / 1048576).toFixed(1)}MB`, 4000);
        setSaveStatus(`영상 저장 완료 (${ext.toUpperCase()})`);
      }
      cleanupTracks();
      cleanupExport(job);
      render(playhead);
    };
    try { rec.stop(); } catch (e) { rec.onstop && rec.onstop(); }
  };

  const tick = () => {
    if (!exportJob || exportJob !== job) return;
    if (job.cancel) { finish(); return; }
    const t = acx.currentTime - t0;
    if (t >= total) { finish(); return; }
    render(Math.max(0, t), { preview: false });
    showProgress(t / total, `${t.toFixed(1)}s / ${total.toFixed(1)}s · ${Math.round((t / total) * 100)}%`);
    job.raf = requestAnimationFrame(tick);
  };
  job.raf = requestAnimationFrame(tick);
}

function cleanupExport(job) {
  if (job.raf) cancelAnimationFrame(job.raf);
  exportJob = null;
  setExportUI(false);
  hideProgress();
  updateTransport();
}

/* PNG 저장 */
async function exportPNG(all) {
  await ensureFonts();
  if (!state.cuts.length) return;
  const items = all
    ? state.cuts.map((c, i) => ({ cut: c, i }))
    : [{ cut: currentCut() || state.cuts[0], i: Math.max(0, currentIndex()) }];

  if (all) toast(`PNG ${items.length}장을 저장합니다. 브라우저가 여러 파일 저장을 물으면 허용해 주세요.`, 4000);

  for (const { cut, i } of items) {
    const start = startTime(i);
    render(start + 0.001, { preview: false });
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (!blob) { toast('PNG 변환 실패'); return; }
    const d = cutDuration(cut);
    download(blob, `뾰로롱_컷${String(i + 1).padStart(2, '0')}_${d.toFixed(1)}s.png`);
    await sleep(all ? 380 : 60);
  }
  render(playhead);
  if (!all) toast('PNG를 저장했습니다');
}

/* =========================================================
   이벤트 연결
   ========================================================= */
function bindEvents() {
  // 재생/정지
  $('#btnPlay').addEventListener('click', () => {
    if (playing) pausePlayback();
    else startPlayback();
  });

  // 스크럽
  const scrub = $('#scrub');
  scrub.addEventListener('input', () => {
    pausePlayback();
    const total = totalDuration();
    playhead = (num(scrub.value, 0) / 1000) * total;
    render(playhead);
    updateTransport();
  });

  // 컷 추가
  $('#btnAddIntro').addEventListener('click', () => addCut('intro'));
  $('#btnAddBody').addEventListener('click', () => addCut('body'));
  $('#btnAddEnding').addEventListener('click', () => addCut('ending'));

  // 타입 전환
  $('#typeSeg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-type]');
    const cut = currentCut();
    if (!b || !cut) return;
    cut.type = b.dataset.type;
    if (cut.type === 'ending' && !cut.text.trim()) cut.text = '구독 누르시고\n오늘도 건강하세요 \u2665';
    renderEditor(); renderCutList(); render(playhead); scheduleSave();
  });

  // 2번째 줄 색
  $('#secondColorSeg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-color]');
    const cut = currentCut();
    if (!b || !cut) return;
    cut.secondColor = b.dataset.color;
    renderEditor(); render(playhead); scheduleSave();
  });

  // 엔딩 프리셋
  $('#btnEndingPreset').addEventListener('click', () => {
    const cut = currentCut();
    if (!cut) return;
    cut.text = '구독 누르시고\n오늘도 건강하세요 \u2665';
    cut.type = 'ending';
    renderEditor(); renderCutList(); render(playhead); scheduleSave();
    toast('엔딩 문구를 넣었습니다');
  });

  // 자막 텍스트
  const ta = $('#cutText');
  let textTimer = 0;
  ta.addEventListener('input', () => {
    const cut = currentCut();
    if (!cut) return;
    cut.text = ta.value;
    render(playhead);
    scheduleSave();
    clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      const item = $(`.cut-item[data-id="${cut.id}"] .cut-preview`);
      if (item) item.textContent = firstLine(cut.text);
    }, 260);
  });

  // 이미지 선택
  $('#imgInput').addEventListener('change', async (ev) => {
    const files = Array.from(ev.target.files || []);
    ev.target.value = '';
    if (files.length) await applyImages(files);
  });
  $('#btnClearImg').addEventListener('click', () => {
    const cut = currentCut();
    if (!cut || !cut.imgKey) return;
    const oldKey = cut.imgKey;
    cut.imgKey = null;
    if (!state.cuts.some((c) => c.imgKey === oldKey)) {
      assets.delete(oldKey); savedAssets.delete(oldKey); idbDel(oldKey);
    }
    syncAll(); scheduleSave();
  });

  // 확대 / 이동
  const onFrameChange = () => {
    const cut = currentCut();
    if (!cut) return;
    cut.zoom = clamp(num($('#zoom').value, 100) / 100, 1, 2.5);
    cut.offsetX = clamp(num($('#offX').value, 0), -540, 540);
    cut.offsetY = clamp(num($('#offY').value, 0), -960, 960);
    $('#zoomVal').textContent = Math.round(cut.zoom * 100) + '%';
    $('#offXVal').textContent = String(Math.round(cut.offsetX));
    $('#offYVal').textContent = String(Math.round(cut.offsetY));
    render(playhead);
    scheduleSave();
  };
  ['#zoom', '#offX', '#offY'].forEach((sel) => $(sel).addEventListener('input', onFrameChange));
  $('#btnResetFrame').addEventListener('click', () => {
    const cut = currentCut();
    if (!cut) return;
    cut.zoom = 1; cut.offsetX = 0; cut.offsetY = 0;
    renderEditor(); render(playhead); scheduleSave();
  });

  // 길이
  $('#cutDur').addEventListener('change', () => {
    const cut = currentCut();
    if (!cut) return;
    cut.duration = clamp(num($('#cutDur').value, 3), 0.5, 30);
    $('#cutDur').value = String(cutDuration(cut));
    renderCutList(); renderTimeline(); updateTransport(); render(playhead); scheduleSave();
  });

  // 오디오
  $('#audioInput').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (f) await applyAudioFile(f);
  });
  $('#btnClearAudio').addEventListener('click', () => {
    pausePlayback();
    if (audioMeta.key) { idbDel(audioMeta.key); savedAssets.delete(audioMeta.key); }
    audioBuffer = null; audioBlob = null;
    audioMeta = { name: '', key: null, duration: 0, bytes: 0 };
    updateAudioInfo(); scheduleSave();
    toast('오디오를 지웠습니다');
  });
  $('#volume').addEventListener('input', () => {
    state.settings.volume = clamp(num($('#volume').value, 100) / 100, 0, 1);
    $('#volVal').textContent = Math.round(state.settings.volume * 100) + '%';
    if (playGain) playGain.gain.value = state.settings.volume;
    scheduleSave();
  });

  // 화면 설정
  $('#safeZone').addEventListener('change', (ev) => {
    state.settings.safeZone = ev.target.checked; render(playhead); scheduleSave();
  });
  $('#bodyScrim').addEventListener('change', (ev) => {
    state.settings.bodyScrim = ev.target.checked; render(playhead); scheduleSave();
  });

  // 내보내기
  $('#btnExportVideo').addEventListener('click', exportVideo);
  $('#btnPngCurrent').addEventListener('click', () => exportPNG(false));
  $('#btnPngAll').addEventListener('click', () => exportPNG(true));
  $('#btnSaveJson').addEventListener('click', exportProjectJSON);
  $('#jsonInput').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (f) await importProjectJSON(f);
  });
  $('#btnNewProject').addEventListener('click', async () => {
    if (!confirm('현재 작업을 지우고 새로 시작할까요?\n(필요하면 먼저 프로젝트 저장(.json)으로 백업하세요)')) return;
    pausePlayback();
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    await idbClear();
    assets.clear(); savedAssets.clear();
    audioBuffer = null; audioBlob = null;
    audioMeta = { name: '', key: null, duration: 0, bytes: 0 };
    state = defaultProject();
    selectedId = state.cuts[0].id;
    playhead = 0;
    syncSettingsUI(); syncAll(); updateAudioInfo(); scheduleSave();
    toast('새 프로젝트를 시작했습니다');
  });

  // 도움말
  $('#btnHelp').addEventListener('click', () => {
    const d = $('#helpDialog');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  });

  // 스페이스 = 재생/정지
  document.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space') return;
    const tag = (ev.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'button', 'select'].includes(tag)) return;
    ev.preventDefault();
    if (playing) pausePlayback(); else startPlayback();
  });

  // 이미지 드래그&드롭 (캔버스 위)
  const frame = document.querySelector('.canvas-frame');
  ['dragover', 'dragenter'].forEach((t) => frame.addEventListener(t, (e) => { e.preventDefault(); frame.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((t) => frame.addEventListener(t, (e) => { e.preventDefault(); frame.classList.remove('dragover'); }));
  frame.addEventListener('drop', async (e) => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    const auds = files.filter((f) => f.type.startsWith('audio/'));
    if (imgs.length) await applyImages(imgs);
    if (auds.length) await applyAudioFile(auds[0]);
  });

  // 폰트 로드 후 다시 그리기
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', () => render(playhead));
  }
  window.addEventListener('beforeunload', (e) => {
    if (exportJob) { e.preventDefault(); e.returnValue = '녹화 중입니다. 창을 닫으면 저장되지 않습니다.'; return e.returnValue; }
  });
}

/* ---------------- 시작 ---------------- */
bindEvents();
boot();
