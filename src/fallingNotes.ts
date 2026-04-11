import type { Midi } from '@tonejs/midi';
import { assignHandForNote, type FlatNote, type Hand } from './midiScore';
import { isWhiteKey, keyCenterXInKeyboard, keyboardInnerWidthPx, PIANO_LAYOUT } from './pianoKeyboard';

const LANE_MIN_HEIGHT = 140;

/**
 * 音符从进入轨道到抵达判定线的时长（秒）。自动播放与 MIDI 跟弹共用同一套下落 / 缩短几何。
 */
const NOTE_APPROACH_SEC = 0.8;

export type KeyboardFallingState = {
  step: number;
  group: FlatNote[];
  hit: Map<number, number>;
  /** 整组弹对后的闪动阶段：轨道内不画条，避免与键盘闪动叠影 */
  groupCompleteFlash: boolean;
};

export type FallingNotesHandle = {
  setRange: (startMidi: number, endMidi: number) => void;
  setSource: (notes: FlatNote[], midi: Midi) => void;
  update: (nowSec: number) => void;
  updateKeyboardPractice: (state: KeyboardFallingState | null) => void;
  clear: () => void;
  dispose: () => void;
};

type FallGeom =
  | { kind: 'hidden' }
  | { kind: 'gone' }
  | { kind: 'fall' | 'sustain'; y: number; height: number };

function durVisForNote(n: FlatNote): number {
  return Math.min(72, 10 + n.duration * 38);
}

/**
 * 给定「乐谱时间」t（秒）与轨道高度，计算条的几何（与自动播放时间轴一致）。
 * 区间：[hit−APPROACH, hit) 下落；[hit, release) 缩短；其余隐藏或已结束。
 */
function fallGeometryForNote(n: FlatNote, tSec: number, hitY: number): FallGeom {
  const hit = n.time;
  const release = hit + Math.max(0.04, n.duration);
  const la = NOTE_APPROACH_SEC;
  const durVis = durVisForNote(n);

  if (tSec >= release) return { kind: 'gone' };
  if (tSec < hit - la) return { kind: 'hidden' };

  if (tSec < hit) {
    const span = Math.max(1e-6, la);
    const pFall = Math.min(1, Math.max(0, (tSec - (hit - la)) / span));
    const bottom = pFall * hitY;
    return { kind: 'fall', y: bottom - durVis, height: durVis };
  }

  const sustainSec = Math.max(1e-4, release - hit);
  const q = Math.min(1, Math.max(0, (tSec - hit) / sustainSec));
  const height = durVis * (1 - q);
  return { kind: 'sustain', y: hitY - height, height };
}

function fallingNoteClasses(h: Hand, whiteKey: boolean): string {
  const hand = h === 'bass' ? 'lh' : 'rh';
  const key = whiteKey ? 'white' : 'black';
  return `falling-note falling-note--${hand} falling-note--key-${key}`;
}

function instanceSlotBefore(group: FlatNote[], idx: number): number {
  const m = group[idx].midi;
  let c = 0;
  for (let i = 0; i < idx; i++) {
    if (group[i].midi === m) c++;
  }
  return c;
}

function noteSatisfied(
  group: FlatNote[],
  idx: number,
  hit: Map<number, number>,
  groupCompleteFlash: boolean,
): boolean {
  if (groupCompleteFlash) return true;
  const n = group[idx];
  const slot = instanceSlotBefore(group, idx);
  return (hit.get(n.midi) ?? 0) > slot;
}

/**
 * 在钢琴上方绘制与键盘对齐的下落音符条。
 * 自动播放与跟弹共用 {@link fallGeometryForNote}；跟弹在未弹对且已过 hit 时刻时将条钉在判定线，直到弹对后再走同一缩短曲线。
 */
export function createFallingNotesLane(outerHost: HTMLElement): FallingNotesHandle {
  const lane = document.createElement('div');
  lane.className = 'falling-lane';
  lane.setAttribute('aria-hidden', 'true');

  const inner = document.createElement('div');
  inner.className = 'falling-lane-inner';
  lane.appendChild(inner);

  outerHost.insertBefore(lane, outerHost.firstChild);

  let startMidi = 48;
  let endMidi = 84;
  let notes: FlatNote[] = [];
  let midiFile: Midi | null = null;

  let kbState: KeyboardFallingState | null = null;
  let kbRaf = 0;
  let kbLastStep = -999;
  /** 当前 step 开始时的 performance.now()；与乐谱 hit 对齐得到虚拟乐谱时间 */
  let kbGroupWallStartMs = 0;
  /** `${step}-${idx}` → 弹对时刻 performance.now()，用于 t = note.time + Δ 代入同一几何 */
  const kbShrinkWallStart = new Map<string, number>();

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
    if (!kbState || !midiFile || kbState.group.length === 0) {
      inner.replaceChildren();
      return;
    }

    if (kbState.groupCompleteFlash) {
      inner.replaceChildren();
      return;
    }

    const { whiteW, blackW } = PIANO_LAYOUT;
    const h = Math.max(LANE_MIN_HEIGHT, lane.clientHeight || LANE_MIN_HEIGHT);
    const hitY = h - 6;
    const nowMs = performance.now();

    const frag = document.createDocumentFragment();
    let needAnotherFrame = false;

    const { step, group, hit, groupCompleteFlash } = kbState;

    const hit0 = Math.min(...group.map((n) => n.time));
    const wallElapsedSec = (nowMs - kbGroupWallStartMs) / 1000;
    const tVirt = hit0 - NOTE_APPROACH_SEC + wallElapsedSec;

    for (let idx = 0; idx < group.length; idx++) {
      const n = group[idx];
      const cx = keyCenterXInKeyboard(n.midi, startMidi, endMidi);
      if (cx === null) continue;

      const satisfied = noteSatisfied(group, idx, hit, groupCompleteFlash);
      const key = `${step}-${idx}`;

      const isWhite = isWhiteKey(n.midi);
      const barW = Math.max(6, (isWhite ? whiteW : blackW) - 4);
      const durVis = durVisForNote(n);
      const hand = assignHandForNote(n, midiFile);
      const el = document.createElement('div');
      el.className = fallingNoteClasses(hand, isWhite);

      let y: number;
      let height: number;

      if (!satisfied) {
        if (tVirt < n.time) {
          const geom = fallGeometryForNote(n, tVirt, hitY);
          if (geom.kind === 'hidden' || geom.kind === 'gone') continue;
          y = geom.y;
          height = geom.height;
          if (geom.kind === 'fall') needAnotherFrame = true;
        } else {
          y = hitY - durVis;
          height = durVis;
        }
      } else {
        if (!kbShrinkWallStart.has(key)) {
          kbShrinkWallStart.set(key, nowMs);
        }
        const tSec = n.time + (nowMs - kbShrinkWallStart.get(key)!) / 1000;
        const geom = fallGeometryForNote(n, tSec, hitY);
        if (geom.kind === 'gone' || geom.kind === 'hidden') continue;
        y = geom.y;
        height = geom.height;
        if (geom.kind === 'fall') needAnotherFrame = true;
        if (geom.kind === 'sustain' && height >= 0.5) needAnotherFrame = true;
      }

      if (height < 0.5) continue;

      el.style.left = `${cx - barW / 2}px`;
      el.style.top = `${y}px`;
      el.style.width = `${barW}px`;
      el.style.height = `${height}px`;
      el.style.opacity = '0.92';
      frag.appendChild(el);
    }

    inner.replaceChildren(frag);

    if (needAnotherFrame) {
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
    update(nowSec: number) {
      cancelKbAnim();
      kbState = null;
      kbShrinkWallStart.clear();

      if (!midiFile || notes.length === 0) {
        inner.replaceChildren();
        return;
      }

      const t = nowSec;
      const { whiteW, blackW } = PIANO_LAYOUT;
      const h = Math.max(LANE_MIN_HEIGHT, lane.clientHeight || LANE_MIN_HEIGHT);
      const hitY = h - 6;

      const frag = document.createDocumentFragment();

      for (const n of notes) {
        const geom = fallGeometryForNote(n, t, hitY);
        if (geom.kind === 'hidden' || geom.kind === 'gone') continue;

        const cx = keyCenterXInKeyboard(n.midi, startMidi, endMidi);
        if (cx === null) continue;

        const isWhite = isWhiteKey(n.midi);
        const barW = Math.max(6, (isWhite ? whiteW : blackW) - 4);
        const hand = assignHandForNote(n, midiFile);
        const el = document.createElement('div');
        el.className = fallingNoteClasses(hand, isWhite);

        el.style.left = `${cx - barW / 2}px`;
        el.style.top = `${geom.y}px`;
        el.style.width = `${barW}px`;
        el.style.height = `${geom.height}px`;
        el.style.opacity = '0.92';

        frag.appendChild(el);
      }

      inner.replaceChildren(frag);
    },
    updateKeyboardPractice(state: KeyboardFallingState | null) {
      if (state === null) {
        cancelKbAnim();
        kbState = null;
        kbLastStep = -999;
        kbShrinkWallStart.clear();
        kbGroupWallStartMs = 0;
        inner.replaceChildren();
        return;
      }
      if (state.step !== kbLastStep) {
        cancelKbAnim();
        kbShrinkWallStart.clear();
        kbLastStep = state.step;
        kbGroupWallStartMs = performance.now();
      }
      kbState = state;
      scheduleKbFrame();
    },
    clear() {
      cancelKbAnim();
      kbState = null;
      kbShrinkWallStart.clear();
      kbLastStep = -999;
      kbGroupWallStartMs = 0;
      inner.replaceChildren();
    },
    dispose() {
      cancelKbAnim();
      lane.remove();
    },
  };
}
