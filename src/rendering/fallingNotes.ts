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

function buildNoteElement(ctx: NoteRenderContext, geom: FallGeom): HTMLElement | null {
  if (geom.kind === 'hidden' || geom.kind === 'gone') return null;
  if (geom.height <= 0) return null;

  const el = document.createElement('div');
  el.className = fallingNoteClasses(ctx.hand, ctx.isWhite);

  el.style.left = `${ctx.cx - ctx.barW / 2}px`;
  el.style.top = `${geom.y}px`;
  el.style.width = `${ctx.barW}px`;
  el.style.height = `${geom.height}px`;
  el.style.opacity = String(ctx.opacity);

  return el;
}

function renderFallingNotesFrame(
  notes: readonly { note: FlatNote; opacity?: number }[],
  currentTimeSec: number,
  hitY: number,
  startMidi: number,
  endMidi: number,
  midiFile: Midi,
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
    const el = buildNoteElement(ctx, geom);
    if (el) frag.appendChild(el);
  }

  return frag;
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

  let kbState: KeyboardFallingState | null = null;
  let kbRaf = 0;

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

  const runKeyboardPracticeFrame = () => {
    if (!kbState || !midiFile || kbState.notes.length === 0) {
      inner.replaceChildren();
      return;
    }

    const hitY = resolveHitY();
    const items = kbState.notes.map((ns) => ({
      note: ns.note,
      opacity: ns.isHit ? 1 : 0.92,
    }));

    const frag = renderFallingNotesFrame(items, kbState.currentTimeSec, hitY, startMidi, endMidi, midiFile);
    inner.replaceChildren(frag);

    if (frag.childNodes.length > 0) {
      scheduleKbFrame();
    }
  };

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
    update(nowSec: number) {
      cancelKbAnim();
      kbState = null;

      if (!midiFile || notes.length === 0) {
        inner.replaceChildren();
        return;
      }

      const hitY = resolveHitY();
      const items = notes.map((n) => ({ note: n }));
      const frag = renderFallingNotesFrame(items, nowSec, hitY, startMidi, endMidi, midiFile);
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
      lane.remove();
    },
  };
}
