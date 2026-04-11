import type { Midi } from '@tonejs/midi';
import { assignHandForNote, type FlatNote, type Hand } from './midiScore';
import { isWhiteKey, keyCenterXInKeyboard, keyboardInnerWidthPx, PIANO_LAYOUT } from './pianoKeyboard';

const LOOKAHEAD_SEC = 2.2;
const LANE_MIN_HEIGHT = 140;

export type FallingNotesHandle = {
  setRange: (startMidi: number, endMidi: number) => void;
  setSource: (notes: FlatNote[], midi: Midi) => void;
  update: (nowSec: number) => void;
  clear: () => void;
  dispose: () => void;
};

function fallingNoteClasses(h: Hand, whiteKey: boolean): string {
  const hand = h === 'bass' ? 'lh' : 'rh';
  const key = whiteKey ? 'white' : 'black';
  return `falling-note falling-note--${hand} falling-note--key-${key}`;
}

/**
 * 在钢琴上方绘制与键盘对齐的下落音符条（自动播放时间轴）。
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

  const syncInnerWidth = () => {
    const w = keyboardInnerWidthPx(startMidi, endMidi);
    inner.style.width = `${w}px`;
  };

  syncInnerWidth();

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
        const hit = n.time;
        const release = hit + Math.max(0.04, n.duration);
        if (t >= release) continue;
        if (t < hit - LOOKAHEAD_SEC) continue;

        const cx = keyCenterXInKeyboard(n.midi, startMidi, endMidi);
        if (cx === null) continue;

        const isWhite = isWhiteKey(n.midi);
        const barW = Math.max(6, (isWhite ? whiteW : blackW) - 4);
        const durVis = Math.min(72, 10 + n.duration * 38);
        const hand = assignHandForNote(n, midiFile);
        const el = document.createElement('div');
        el.className = fallingNoteClasses(hand, isWhite);

        /**
         * 下落：底边以恒定像素速度从 0 移到 hitY（与条高无关），所有音符下落快慢一致。
         * 发声后底边固定在 hitY，高度按时值缩到 0。
         */
        const span = Math.max(1e-3, LOOKAHEAD_SEC);
        const pFall = Math.min(1, Math.max(0, (t - (hit - LOOKAHEAD_SEC)) / span));

        let y: number;
        let height: number;
        if (t < hit) {
          const bottom = pFall * hitY;
          y = bottom - durVis;
          height = durVis;
        } else {
          const sustainSec = Math.max(1e-4, release - hit);
          const q = (t - hit) / sustainSec;
          height = durVis * (1 - Math.min(1, Math.max(0, q)));
          y = hitY - height;
        }

        el.style.left = `${cx - barW / 2}px`;
        el.style.top = `${y}px`;
        el.style.width = `${barW}px`;
        el.style.height = `${height}px`;
        el.style.opacity = '0.92';

        frag.appendChild(el);
      }

      inner.replaceChildren(frag);
    },
    clear() {
      inner.replaceChildren();
    },
    dispose() {
      lane.remove();
    },
  };
}
