import type { Midi } from '@tonejs/midi';
import type { Track } from '@tonejs/midi';
import { noteToVexKey } from './pitchUtil';

type MidiNote = Track['notes'][number];

export type Hand = 'treble' | 'bass';

export interface FlatNote {
  midi: number;
  time: number;
  duration: number;
  /** 与 MIDI 文件一致；用于按 tick 切分小节，避免仅用秒+BPM 时在 6/8 等拍号下浮点漂移 */
  ticks: number;
  durationTicks: number;
  trackIndex: number;
  vexKey: string;
  /** MIDI 力度 0‑1 */
  velocity: number;
}

export interface MeasureContext {
  bpm: number;
  timeSig: [number, number];
  /** 每小节所占四分音符数（与 PPQ 一致） */
  beatsPerMeasure: number;
  /** 每小节 tick 数（整数，与 Tone.js Header 一致） */
  ticksPerMeasure: number;
  secPerMeasure: number;
  timeSigStr: string;
}

export function getMeasureContext(midi: Midi): MeasureContext {
  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  const ts = (midi.header.timeSignatures[0]?.timeSignature ?? [4, 4]) as [number, number];
  const den = ts[1] > 0 ? ts[1] : 4;
  const beatsPerMeasure = ts[0] * (4 / den);
  const ppq = midi.header.ppq;
  const ticksPerMeasure = (ts[0] * 4 * ppq) / den;
  const tAfter = midi.header.ticksToSeconds(ticksPerMeasure);
  const t0 = midi.header.ticksToSeconds(0);
  const secPerMeasure = Math.max(1e-6, tAfter - t0);
  return {
    bpm,
    timeSig: [ts[0], den],
    beatsPerMeasure,
    ticksPerMeasure,
    secPerMeasure,
    timeSigStr: `${ts[0]}/${den}`,
  };
}

/**
 * VexFlow Voice 的拍号决定小节总 tick 的“节拍网格”。本项目的时值拆分以四分音符为 1 beat（与 MIDI PPQ、{@link secToBeats} 一致）。
 * 对 6/8 等拍号，Voice 用字面 "6/8" 时以八分音符为 beat，虽总 tick 与 3/4 等价，但易与 formatter / tick 对齐不一致；故在总时值恰为整数个四分音符时改用等价的 x/4。
 * 谱表上的拍号仍用 {@link MeasureContext.timeSigStr} 显示原拍号。
 */
export function vexVoiceTimeStr(timeSig: [number, number]): string {
  const [n, d] = timeSig;
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0 || n <= 0) {
    return '4/4';
  }
  const quarters = (n * 4) / d;
  if (Number.isInteger(quarters) && quarters > 0) {
    return `${quarters}/4`;
  }
  return `${Math.trunc(n)}/${Math.trunc(d)}`;
}

function tracksWithNotes(midi: Midi): number[] {
  const idx: number[] = [];
  midi.tracks.forEach((t, i) => {
    if (t.notes.length > 0) idx.push(i);
  });
  return idx;
}

/** 多轨：按轨道序号分谱表；单轨：按每个音的音高（中央 C=60）分谱表 */
export function assignHandForNote(note: Pick<FlatNote, 'trackIndex' | 'midi'>, midi: Midi): Hand {
  const withNotes = tracksWithNotes(midi);
  if (withNotes.length >= 2) {
    const order = [...withNotes].sort((a, b) => a - b);
    return note.trackIndex === order[0] ? 'treble' : 'bass';
  }
  return note.midi >= 60 ? 'treble' : 'bass';
}

export function flattenNotes(midi: Midi): FlatNote[] {
  const out: FlatNote[] = [];
  midi.tracks.forEach((track, trackIndex) => {
    track.notes.forEach((n: MidiNote) => {
      out.push({
        midi: n.midi,
        time: n.time,
        duration: n.duration,
        ticks: n.ticks,
        durationTicks: n.durationTicks,
        trackIndex,
        vexKey: noteToVexKey(n),
        velocity: 'velocity' in n ? (n.velocity as number) : 0.78,
      });
    });
  });
  out.sort((a, b) => a.time - b.time || a.midi - b.midi);
  return out;
}

function secToBeats(sec: number, bpm: number): number {
  return sec * (bpm / 60);
}

const GRID = 1 / 16;

function quantize(x: number): number {
  return Math.round(x / GRID) * GRID;
}

interface SliceNote {
  start: number;
  end: number;
  vexKey: string;
}

function clipNote(n: FlatNote, measureStart: number, measureEnd: number, bpm: number): SliceNote | null {
  const t0 = Math.max(n.time, measureStart);
  const t1 = Math.min(n.time + n.duration, measureEnd);
  if (t1 <= t0 + 1e-6) return null;
  return {
    start: quantize(secToBeats(t0 - measureStart, bpm)),
    end: quantize(secToBeats(t1 - measureStart, bpm)),
    vexKey: n.vexKey,
  };
}

/** 按 MIDI tick 切分小节内片段，网格为 1/16 个四分音符（与 GRID 一致） */
function clipNoteByTicks(
  n: FlatNote,
  measureStartTick: number,
  measureEndTick: number,
  ppq: number,
): SliceNote | null {
  const t0 = Math.max(n.ticks, measureStartTick);
  const t1 = Math.min(n.ticks + n.durationTicks, measureEndTick);
  if (t1 <= t0) return null;
  const tickGrid = ppq / 16;
  const rel0 = t0 - measureStartTick;
  const rel1 = t1 - measureStartTick;
  const q0 = Math.round(rel0 / tickGrid) * tickGrid;
  const q1 = Math.round(rel1 / tickGrid) * tickGrid;
  if (q1 <= q0) return null;
  return {
    start: q0 / ppq,
    end: q1 / ppq,
    vexKey: n.vexKey,
  };
}

export interface VoiceAtom {
  keys: string[];
  duration: string;
  dots?: number;
  rest?: boolean;
}

/** 从大到小贪心拆分；附点时值 = 本音 + 其一半；须含 64 分及附点 64 分，避免剩余时值被高估 */
const DUR_ROWS: { beats: number; code: string; dots?: number }[] = [
  { beats: 6, code: 'w', dots: 1 },
  { beats: 4, code: 'w' },
  { beats: 3, code: 'h', dots: 1 },
  { beats: 2, code: 'h' },
  { beats: 1.5, code: 'q', dots: 1 },
  { beats: 1, code: 'q' },
  { beats: 0.75, code: '8', dots: 1 },
  { beats: 0.5, code: '8' },
  { beats: 0.375, code: '16', dots: 1 },
  { beats: 0.25, code: '16' },
  { beats: 0.1875, code: '32', dots: 1 },
  { beats: 0.125, code: '32' },
  { beats: 0.09375, code: '64', dots: 1 },
  { beats: 0.0625, code: '64' },
];

function decomposeBeats(beats: number): { duration: string; dots?: number }[] {
  let left = Math.max(0, Math.round(beats * 64) / 64);
  const out: { duration: string; dots?: number }[] = [];
  for (const row of DUR_ROWS) {
    while (left >= row.beats - 1e-5) {
      out.push({ duration: row.code, dots: row.dots });
      left -= row.beats;
    }
  }
  return out;
}

function pushRests(atoms: VoiceAtom[], beats: number, clef: Hand) {
  const anchor = clef === 'treble' ? 'b/4' : 'd/3';
  for (const d of decomposeBeats(beats)) {
    atoms.push({ keys: [anchor], duration: d.duration, dots: d.dots, rest: true });
  }
}

/** 同一声部内去掉重叠：后出现的音符从上一音结束处开始 */
interface ChordEv {
  start: number;
  end: number;
  keys: string[];
}

/** 同一时间点的音符合成和弦；再按时间顺序解决交叠（简化为连续块） */
function slicesToChordEvents(slices: SliceNote[]): ChordEv[] {
  const byStart = new Map<number, SliceNote[]>();
  for (const s of slices) {
    const st = quantize(s.start);
    const arr = byStart.get(st) ?? [];
    arr.push(s);
    byStart.set(st, arr);
  }
  const chords: ChordEv[] = [];
  for (const [st, arr] of [...byStart.entries()].sort((a, b) => a[0] - b[0])) {
    const keys = [...new Set(arr.map((x) => x.vexKey))].sort();
    const en = Math.min(...arr.map((x) => x.end));
    chords.push({ start: st, end: en, keys });
  }
  let lastEnd = 0;
  const resolved: ChordEv[] = [];
  for (const c of chords) {
    const st = Math.max(c.start, lastEnd);
    const en = Math.max(st, c.end);
    if (en - st > 1e-5) {
      resolved.push({ start: st, end: en, keys: c.keys });
      lastEnd = en;
    }
  }
  return resolved;
}

export function buildAtomsForHand(
  flat: FlatNote[],
  midi: Midi,
  hand: Hand,
  ctx: MeasureContext,
  measureIndex: number,
): VoiceAtom[] {
  const measureStartTick = measureIndex * ctx.ticksPerMeasure;
  const measureEndTick = (measureIndex + 1) * ctx.ticksPerMeasure;
  const secStart = measureIndex * ctx.secPerMeasure;
  const secEnd = secStart + ctx.secPerMeasure;
  const ppq = midi.header.ppq;
  const slices: SliceNote[] = [];
  for (const n of flat) {
    if (assignHandForNote(n, midi) !== hand) continue;
    const sl =
      Number.isFinite(n.ticks) && Number.isFinite(n.durationTicks) && n.durationTicks >= 0
        ? clipNoteByTicks(n, measureStartTick, measureEndTick, ppq)
        : clipNote(n, secStart, secEnd, ctx.bpm);
    if (sl) slices.push(sl);
  }
  const chords = slicesToChordEvents(slices);
  const atoms: VoiceAtom[] = [];
  let cursor = 0;
  const EPS = 1 / 64;

  for (const ch of chords) {
    if (ch.start > cursor + EPS) {
      pushRests(atoms, ch.start - cursor, hand);
      cursor = ch.start;
    }
    const dur = Math.max(GRID, ch.end - cursor);
    for (const d of decomposeBeats(dur)) {
      atoms.push({ keys: [...ch.keys], duration: d.duration, dots: d.dots });
    }
    cursor += dur;
  }

  const tail = ctx.beatsPerMeasure - cursor;
  if (tail > EPS) {
    pushRests(atoms, tail, hand);
  }

  return atoms;
}

export function measureCount(midi: Midi, ctx: MeasureContext): number {
  const ticks = midi.durationTicks;
  if (ticks <= 0) return 1;
  return Math.max(1, Math.ceil(ticks / ctx.ticksPerMeasure - 1e-9));
}
