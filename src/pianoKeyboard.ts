import type { Hand } from './midiScore';

const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);

const VISUAL_CLASSES = ['expect-lh', 'expect-rh', 'active-lh', 'active-rh', 'pressed', 'expected', 'active'] as const;

export function isWhiteKey(midi: number): boolean {
  return WHITE_PC.has(midi % 12);
}

function prevWhiteMidi(m: number, startMidi: number): number | null {
  for (let x = m - 1; x >= startMidi; x--) {
    if (isWhiteKey(x)) return x;
  }
  return null;
}

/** 约三个八度（默认 MIDI 48–84），白键横向排列，黑键叠在上层 */
export function createPianoKeyboard(
  container: HTMLElement,
  startMidi = 48,
  endMidi = 84,
): Map<number, HTMLElement> {
  container.innerHTML = '';
  container.className = 'piano-keyboard';

  const whiteIndex = new Map<number, number>();
  let wi = 0;
  for (let m = startMidi; m <= endMidi; m++) {
    if (isWhiteKey(m)) {
      whiteIndex.set(m, wi);
      wi++;
    }
  }

  const whiteW = 28;
  const whiteH = 120;
  const blackW = 18;
  const blackH = 72;

  const inner = document.createElement('div');
  inner.className = 'piano-inner';

  const whiteRow = document.createElement('div');
  whiteRow.className = 'piano-whites';
  whiteRow.style.width = `${wi * whiteW}px`;

  const keyEls = new Map<number, HTMLElement>();

  for (let m = startMidi; m <= endMidi; m++) {
    if (!isWhiteKey(m)) continue;
    const k = document.createElement('button');
    k.type = 'button';
    k.className = 'piano-key white';
    k.dataset.midi = String(m);
    k.style.width = `${whiteW}px`;
    k.style.height = `${whiteH}px`;
    keyEls.set(m, k);
    whiteRow.appendChild(k);
  }

  inner.appendChild(whiteRow);

  const blackLayer = document.createElement('div');
  blackLayer.className = 'piano-blacks';
  blackLayer.style.width = `${wi * whiteW}px`;

  for (let m = startMidi; m <= endMidi; m++) {
    if (isWhiteKey(m)) continue;
    const prev = prevWhiteMidi(m, startMidi);
    if (prev === null) continue;
    const idx = whiteIndex.get(prev);
    if (idx === undefined) continue;

    const k = document.createElement('button');
    k.type = 'button';
    k.className = 'piano-key black';
    k.dataset.midi = String(m);
    k.style.width = `${blackW}px`;
    k.style.height = `${blackH}px`;
    const left = (idx + 0.58) * whiteW - blackW / 2;
    k.style.left = `${left}px`;
    keyEls.set(m, k);
    blackLayer.appendChild(k);
  }

  inner.appendChild(blackLayer);
  container.appendChild(inner);
  return keyEls;
}

function handToExpectClass(h: Hand): string {
  return h === 'bass' ? 'expect-lh' : 'expect-rh';
}

function handToActiveClass(h: Hand): string {
  return h === 'bass' ? 'active-lh' : 'active-rh';
}

/**
 * 左手（低音谱 / bass）与右手（高音谱 / treble）用不同描边与填色；`pressed` 为 MIDI 当前按下的键（外圈高亮）。
 */
export function applyKeyVisuals(
  keyEls: Map<number, HTMLElement>,
  v: {
    expected?: Map<number, Hand>;
    active?: Map<number, Hand>;
    pressed?: Set<number>;
  },
) {
  for (const [midi, el] of keyEls) {
    el.classList.remove(...VISUAL_CLASSES);
    const exp = v.expected?.get(midi);
    if (exp !== undefined) el.classList.add(handToExpectClass(exp));
    const act = v.active?.get(midi);
    if (act !== undefined) el.classList.add(handToActiveClass(act));
    if (v.pressed?.has(midi)) el.classList.add('pressed');
  }
}
