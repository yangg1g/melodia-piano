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
  update: (nowSec: number) => void;
  updateKeyboardPractice: (state: KeyboardFallingState | null) => void;
  clear: () => void;
  dispose: () => void;
};

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
    },
    dispose() {
      cancelKbAnim();
      lane.remove();
    },
  };
}
