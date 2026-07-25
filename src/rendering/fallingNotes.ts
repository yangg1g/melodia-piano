import type { Midi } from '@tonejs/midi';
import { assignHandForNote, type FlatNote, type Hand } from '../core/midiScore';
import { isWhiteKey, keyCenterXInKeyboard, keyboardInnerWidthPx, PIANO_LAYOUT } from './pianoKeyboard';

const LANE_MIN_HEIGHT = 220;
let VISIBLE_WINDOW_SEC = 3;

export type NoteState = {
  note: FlatNote;
  isHit: boolean;
  hitTimeSec: number | null;
};

export type KeyboardFallingState = {
  notes: NoteState[];
  currentTimeSec: number;
};

export type FallingNotesHandle = {
  setRange: (startMidi: number, endMidi: number) => void;
  setSource: (notes: FlatNote[], midi: Midi) => void;
  setSpeed: (speed: number) => void;
  setTimingWindows: (w: { perfect: number; ok: number; bad: number }) => void;
  setLoopRange: (startSec: number, endSec: number) => void;
  /** 设置指法数据：NoteKey 级别 + MIDI:时间 → NoteKey 映射 */
  setFingerData: (fingerNumbers: Map<string, number>, flatNotes: FlatNote[]) => void;
  setOnNoteClick: (cb: ((noteKey: string | null, midi: number) => void) | null) => void;
  update: (nowSec: number) => void;
  updateKeyboardPractice: (state: KeyboardFallingState | null) => void;
  pushTimingMarker: (offsetMs: number, judgement: 'PERFECT' | 'OK' | 'BAD') => void;
  tickMarkerTime: (wallSec: number) => void;
  clear: () => void;
  dispose: () => void;
};

/** 最近按键的偏差信息，用于在 falling 区域上方绘制时序散点 */
export interface TimingDot {
  offsetMs: number;
  judgement: 'PERFECT' | 'OK' | 'BAD' | 'MISS';
}

type FallGeom =
  | { kind: 'hidden' }
  | { kind: 'gone' }
  | { kind: 'visible'; y: number; height: number };

function fallGeometryForNote(
  n: FlatNote,
  tSec: number,
  hitY: number,
  visibleWindowSec: number = VISIBLE_WINDOW_SEC,
): FallGeom {
  const hit = n.time;
  const release = hit + Math.max(0, n.duration);

  const windowStart = tSec;
  const windowEnd = tSec + visibleWindowSec;

  if (release < windowStart) return { kind: 'gone' };
  if (hit > windowEnd) return { kind: 'hidden' };

  const totalWindowSec = windowEnd - windowStart;

  function timeToY(time: number): number {
    return ((windowEnd - time) / totalWindowSec) * hitY;
  }

  let yTop: number;
  let yBottom: number;

  if (release <= windowEnd && hit >= windowStart) {
    yTop = timeToY(release);
    yBottom = timeToY(hit);
  } else if (hit < windowStart && release > windowEnd) {
    yTop = 0;
    yBottom = hitY;
  } else if (hit < windowStart) {
    yTop = timeToY(release);
    yBottom = hitY;
  } else {
    yTop = 0;
    yBottom = timeToY(hit);
  }

  let height = Math.max(1, yBottom - yTop);

  return { kind: 'visible', y: yTop, height };
}

function fallingNoteClasses(h: Hand, whiteKey: boolean): string {
  const hand = h === 'bass' ? 'lh' : 'rh';
  const key = whiteKey ? 'white' : 'black';
  return `falling-note falling-note--${hand} falling-note--key-${key}`;
}

interface NoteRenderContext {
  midi: number;
  hand: Hand;
  isWhite: boolean;
  barW: number;
  cx: number;
  opacity: number;
}

function resolveNoteRenderContext(
  midi: number,
  hand: Hand,
  startMidi: number,
  endMidi: number,
): NoteRenderContext | null {
  const cx = keyCenterXInKeyboard(midi, startMidi, endMidi);
  if (cx === null) return null;

  const isWhite = isWhiteKey(midi);
  const { whiteW, blackW } = PIANO_LAYOUT;
  const barW = Math.max(6, (isWhite ? whiteW : blackW) - 4);

  return { midi, hand, isWhite, barW, cx, opacity: 0.92 };
}

function buildNoteElement(
  ctx: NoteRenderContext,
  geom: FallGeom,
  noteTime: number,
  finger?: number,
  noteKey?: string,
  onClick?: ((noteKey: string | null, midi: number) => void) | null,
): HTMLElement | null {
  if (geom.kind === 'hidden' || geom.kind === 'gone') return null;
  if (geom.height <= 0) return null;

  const el = document.createElement('div');
  el.className = fallingNoteClasses(ctx.hand, ctx.isWhite);
  el.dataset.midi = String(ctx.midi);
  el.dataset.time = noteTime.toFixed(3);
  if (noteKey) el.dataset.noteKey = noteKey;
  el.style.cursor = 'pointer';
  if (onClick) {
    const nk = noteKey;
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onClick(nk ?? null, ctx.midi);
    }, true);
  }

  el.style.left = `${ctx.cx - ctx.barW / 2}px`;
  el.style.top = `${geom.y}px`;
  el.style.width = `${ctx.barW}px`;
  el.style.height = `${geom.height}px`;
  el.style.opacity = String(ctx.opacity);

  // 在下落音符上显示指法编号（高度足够时，留最小余量供徽标附着）
  if (finger !== undefined && geom.height >= 10) {
    const lbl = document.createElement('span');
    lbl.className = 'falling-note-finger';
    lbl.textContent = String(finger);
    el.appendChild(lbl);
  }

  return el;
}

function renderFallingNotesFrame(
  notes: readonly { note: FlatNote; opacity?: number }[],
  currentTimeSec: number,
  hitY: number,
  startMidi: number,
  endMidi: number,
  midiFile: Midi,
  fingerNumbers?: Map<string, number>,
  onNoteClick?: ((noteKey: string | null, midi: number) => void) | null,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  for (const item of notes) {
    const n = item.note;
    const hand = assignHandForNote(n, midiFile);

    const ctx = resolveNoteRenderContext(n.midi, hand, startMidi, endMidi);
    if (!ctx) continue;

    if (item.opacity !== undefined) {
      ctx.opacity = item.opacity;
    }

    const geom = fallGeometryForNote(n, currentTimeSec, hitY);
    // 直接从 FlatNote.noteKey 取指法
    const noteKey = n.noteKey;
    const finger = (noteKey && fingerNumbers) ? fingerNumbers.get(noteKey) : undefined;
    const el = buildNoteElement(ctx, geom, n.time, finger, noteKey, onNoteClick);
    if (el) frag.appendChild(el);
  }

  return frag;
}

/** 生成当前位置指示线元素 */
function buildNowLine(hitY: number, offsetSec: number, visibleSec: number): HTMLElement | null {
  const nowY = hitY * (1 + offsetSec / visibleSec);
  if (isNaN(nowY)) return null;
  const el = document.createElement('div');
  el.className = 'falling-now-line';
  el.style.top = `${Math.max(-2, Math.min(hitY + 2, nowY))}px`;
  return el;
}

/** 生成小节范围标记带 */
function buildLoopBand(
  loopStartSec: number,
  loopEndSec: number,
  effectiveTimeSec: number,
  hitY: number,
  visibleSec: number,
): HTMLElement | null {
  const windowStart = effectiveTimeSec;
  const windowEnd = effectiveTimeSec + visibleSec;
  const total = windowEnd - windowStart;
  if (total <= 0) return null;

  const timeToY = (t: number) => ((windowEnd - t) / total) * hitY;

  const yStart = Math.max(0, timeToY(loopEndSec));
  const yEnd = Math.min(hitY, timeToY(loopStartSec));

  if (yEnd <= yStart || yStart >= hitY || yEnd <= 0) return null;

  const el = document.createElement('div');
  el.className = 'falling-loop-band';
  el.style.top = `${yStart}px`;
  el.style.height = `${Math.max(1, yEnd - yStart)}px`;
  return el;
}

export function createFallingNotesLane(outerHost: HTMLElement): FallingNotesHandle {
  const lane = document.createElement('div');
  lane.className = 'falling-lane';
  lane.setAttribute('aria-hidden', 'true');

  const inner = document.createElement('div');
  inner.className = 'falling-lane-inner';
  lane.appendChild(inner);

  // 预览线：显示前 10 秒音符，三种判定区域色带
  const previewCanvas = document.createElement('canvas');
  previewCanvas.className = 'falling-preview-canvas';
  lane.insertBefore(previewCanvas, inner);
  const PREVIEW_WINDOW_SEC = 10;

  // 命中记录：用于预览线上显示最近按键的偏差
  interface HitMarker {
    offsetMs: number;
    judgement: 'PERFECT' | 'OK' | 'BAD';
    wallSec: number;
  }
  let hitMarkers: HitMarker[] = [];
  let hitMarkerWallBase = 0;
  let hitMarkerWallSec = 0;
  let timingWindows = { perfect: 80, ok: 140, bad: 200 };

  const renderPreviewLine = () => {
    if (hitMarkers.length === 0) {
      previewCanvas.style.display = 'none';
      return;
    }
    previewCanvas.style.display = '';
    const dpr = window.devicePixelRatio || 1;
    const w = previewCanvas.clientWidth;
    const h = previewCanvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    previewCanvas.width = w * dpr;
    previewCanvas.height = h * dpr;
    const ctx = previewCanvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const midY = h / 2;
    const lw = 3;

    // 一条线，渐变：BAD(橙) → OK(紫) → PERFECT(黄) → OK(紫) → BAD(橙)
    const { perfect, ok, bad } = timingWindows;
    const offsetToX = (ms: number) => {
      const ratio = (ms + bad) / (2 * bad);
      return Math.max(0, Math.min(w, ratio * w));
    };

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#fb923c');                                            // -bad: BAD 橙
    grad.addColorStop((bad - ok) / (2 * bad), '#a78bfa');                       // -ok: OK 紫
    grad.addColorStop((bad - perfect) / (2 * bad), '#fbbf24');                  // -perfect: PERFECT 黄
    grad.addColorStop(0.5, '#fbbf24');                                          // 0: PERFECT 黄
    grad.addColorStop((bad + perfect) / (2 * bad), '#fbbf24');                  // +perfect: PERFECT 黄
    grad.addColorStop((bad + ok) / (2 * bad), '#a78bfa');                       // +ok: OK 紫
    grad.addColorStop(1, '#fb923c');                                            // +bad: BAD 橙

    ctx.strokeStyle = grad;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 绘制命中标记，按时间淡出
    for (const m of hitMarkers) {
      const age = hitMarkerWallSec - m.wallSec;
      if (age > PREVIEW_WINDOW_SEC) continue;
      const opacity = 1 - age / PREVIEW_WINDOW_SEC;
      const x = offsetToX(m.offsetMs);
      const r = 2 + (1 - age / PREVIEW_WINDOW_SEC) * 3;

      let color: string;
      if (m.judgement === 'PERFECT') color = '#fbbf24';
      else if (m.judgement === 'OK') color = '#a78bfa';
      else color = '#fb923c';

      ctx.fillStyle = color;
      ctx.globalAlpha = opacity;
      ctx.beginPath();
      ctx.arc(x, midY, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const pushHitMarker = (offsetMs: number, judgement: 'PERFECT' | 'OK' | 'BAD', wallSec: number) => {
    if (!hitMarkerWallBase) hitMarkerWallBase = wallSec;
    hitMarkers.push({ offsetMs, judgement, wallSec });
    // 清理超过 10 秒的记录
    hitMarkers = hitMarkers.filter(m => wallSec - m.wallSec <= PREVIEW_WINDOW_SEC + 1);
    // 最多保留 50 个
    if (hitMarkers.length > 50) hitMarkers = hitMarkers.slice(-50);
    renderPreviewLine();
  };

  const previewObserver = new ResizeObserver(() => renderPreviewLine());
  previewObserver.observe(lane);

  const resolveHitY = (): number => {
    const ih = inner.clientHeight;
    if (ih > 8) return ih;
    const pad = 14;
    const lh = lane.clientHeight;
    return Math.max(LANE_MIN_HEIGHT, lh > pad ? lh - pad : lh);
  };

  outerHost.insertBefore(lane, outerHost.firstChild);

  let startMidi = 48;
  let endMidi = 84;
  let notes: FlatNote[] = [];
  let midiFile: Midi | null = null;
  /** NoteKey → 手指 */
  let fingerNumbers: Map<string, number> = new Map();
  /** 下落音符点击回调 */
  let onNoteClick: ((noteKey: string | null, midi: number) => void) | null = null;

  let kbState: KeyboardFallingState | null = null;
  let kbRaf = 0;

  // Ctrl+上下箭头偏移：浏览前后音符，不影响播放进度
  let lastTimeSec = 0;
  let dragOffsetSec = 0;

  // 练习模式小节范围
  let loopStartSec = 0;
  let loopEndSec = 0;
  let hasLoopRange = false;

  const syncInnerWidth = () => {
    const w = keyboardInnerWidthPx(startMidi, endMidi);
    inner.style.width = `${w}px`;
  };

  syncInnerWidth();

  const cancelKbAnim = () => {
    if (kbRaf) {
      cancelAnimationFrame(kbRaf);
      kbRaf = 0;
    }
  };

  const scheduleKbFrame = () => {
    if (kbRaf) return;
    kbRaf = requestAnimationFrame(() => {
      kbRaf = 0;
      runKeyboardPracticeFrame();
    });
  };

  /** 根据 kbState 构建命中查找表（用 MIDI + 绝对时间作为 key） */
  const buildHitLookup = (): Map<number, Set<string>> => {
    const map = new Map<number, Set<string>>();
    if (!kbState) return map;
    for (const ns of kbState.notes) {
      const midi = ns.note.midi;
      const absTime = (ns.note.time + loopStartSec).toFixed(3);
      if (!map.has(midi)) map.set(midi, new Set());
      map.get(midi)!.add(absTime);
    }
    return map;
  };

  const runKeyboardPracticeFrame = () => {
    if (!kbState || !midiFile) {
      inner.replaceChildren();
      return;
    }

    lastTimeSec = loopStartSec + kbState.currentTimeSec;
    const effectiveTime = lastTimeSec + dragOffsetSec;
    const hitY = resolveHitY();
    const hitLookup = hasLoopRange ? buildHitLookup() : null;

    const items = notes.map((n) => {
      let opacity = 0.92;
      if (hasLoopRange) {
        const inLoop = n.time >= loopStartSec && n.time < loopEndSec;
        if (!inLoop) {
          // 非循环范围音符：降低不透明度
          opacity = 0.35;
        } else if (hitLookup) {
          const absKey = n.time.toFixed(3);
          const set = hitLookup.get(n.midi);
          if (set && set.has(absKey)) opacity = 1; // 已命中
        }
      }
      return { note: n, opacity };
    });

    const frag = renderFallingNotesFrame(items, effectiveTime, hitY, startMidi, endMidi, midiFile, fingerNumbers, onNoteClick);

    // 当前位置指示线
    const line = buildNowLine(hitY, dragOffsetSec, VISIBLE_WINDOW_SEC);
    if (line) frag.appendChild(line);

    // 循环范围标记带
    if (hasLoopRange) {
      const band = buildLoopBand(loopStartSec, loopEndSec, effectiveTime, hitY, VISIBLE_WINDOW_SEC);
      if (band) frag.appendChild(band);
    }

    inner.replaceChildren(frag);

    if (frag.childNodes.length > 0) {
      scheduleKbFrame();
    }
  };

  // 使用全部音符渲染偏移后的画面（Ctrl+箭头时）
  const renderOffsetFrame = () => {
    if (!midiFile || notes.length === 0) {
      inner.replaceChildren();
      return;
    }
    const effectiveTime = lastTimeSec + dragOffsetSec;
    const hitY = resolveHitY();
    const items = notes.map((n) => ({ note: n }));
    const frag = renderFallingNotesFrame(items, effectiveTime, hitY, startMidi, endMidi, midiFile, fingerNumbers, onNoteClick);

    const line = buildNowLine(hitY, dragOffsetSec, VISIBLE_WINDOW_SEC);
    if (line) frag.appendChild(line);

    if (hasLoopRange) {
      const band = buildLoopBand(loopStartSec, loopEndSec, effectiveTime, hitY, VISIBLE_WINDOW_SEC);
      if (band) frag.appendChild(band);
    }

    inner.replaceChildren(frag);
  };

  const onDocKeyDown = (e: KeyboardEvent) => {
    if (!e.ctrlKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = VISIBLE_WINDOW_SEC * 0.15;
      // ↑ 看后面的音符（offset 增大），↓ 看前面的音符（offset 减小）
      dragOffsetSec += e.key === 'ArrowUp' ? step : -step;
      if (kbState) runKeyboardPracticeFrame();
      else renderOffsetFrame();
    }
  };

  const onDocKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Control' && dragOffsetSec !== 0) {
      dragOffsetSec = 0;
      if (kbState) runKeyboardPracticeFrame();
      else renderOffsetFrame();
    }
  };

  document.addEventListener('keydown', onDocKeyDown);
  document.addEventListener('keyup', onDocKeyUp);

  return {
    setRange(s: number, e: number) {
      startMidi = s;
      endMidi = e;
      syncInnerWidth();
    },
    setSource(n: FlatNote[], m: Midi) {
      notes = n;
      midiFile = m;
    },
    setSpeed(speed: number) {
      VISIBLE_WINDOW_SEC = speed;
    },
    setTimingWindows(w: { perfect: number; ok: number; bad: number }) {
      timingWindows = w;
      renderPreviewLine();
    },
    setLoopRange(startSec: number, endSec: number) {
      loopStartSec = startSec;
      loopEndSec = endSec;
      hasLoopRange = true;
    },
    setFingerData(fn: Map<string, number>, _notes: FlatNote[]) {
      fingerNumbers = fn;
    },
    setOnNoteClick(cb: ((noteKey: string | null, midi: number) => void) | null) {
      onNoteClick = cb;
    },
    update(nowSec: number) {
      cancelKbAnim();
      kbState = null;
      lastTimeSec = nowSec;

      if (!midiFile || notes.length === 0) {
        inner.replaceChildren();
        return;
      }

      const effectiveTime = nowSec + dragOffsetSec;
      const hitY = resolveHitY();
      const items = notes.map((n) => ({ note: n }));
      const frag = renderFallingNotesFrame(items, effectiveTime, hitY, startMidi, endMidi, midiFile, fingerNumbers, onNoteClick);

      const line = buildNowLine(hitY, dragOffsetSec, VISIBLE_WINDOW_SEC);
      if (line) frag.appendChild(line);

      if (hasLoopRange) {
        const band = buildLoopBand(loopStartSec, loopEndSec, effectiveTime, hitY, VISIBLE_WINDOW_SEC);
        if (band) frag.appendChild(band);
      }

      inner.replaceChildren(frag);
    },
    updateKeyboardPractice(state: KeyboardFallingState | null) {
      if (state === null) {
        cancelKbAnim();
        kbState = null;
        inner.replaceChildren();
        return;
      }
      kbState = state;
      scheduleKbFrame();
    },
    clear() {
      cancelKbAnim();
      kbState = null;
      inner.replaceChildren();
      hitMarkers = [];
      hitMarkerWallBase = 0;
      previewCanvas.style.display = 'none';
      hasLoopRange = false;
      loopStartSec = 0;
      loopEndSec = 0;
    },
    pushTimingMarker(offsetMs: number, judgement: 'PERFECT' | 'OK' | 'BAD') {
      pushHitMarker(offsetMs, judgement, hitMarkerWallSec);
    },
    tickMarkerTime(wallSec: number) {
      hitMarkerWallSec = wallSec;
    },
    dispose() {
      cancelKbAnim();
      previewObserver.disconnect();
      document.removeEventListener('keydown', onDocKeyDown);
      document.removeEventListener('keyup', onDocKeyUp);
      lane.remove();
    },
  };
}
