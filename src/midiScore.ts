import type { Midi } from '@tonejs/midi';
import type { Track } from '@tonejs/midi';
import { noteToVexKey } from './pitchUtil';

type MidiNote = Track['notes'][number];

export type Hand = 'treble' | 'bass';

export interface FlatNote {
  midi: number;
  time: number;
  duration: number;
  trackIndex: number;
  vexKey: string;
}

export interface MeasureContext {
  bpm: number;
  timeSig: [number, number];
  beatsPerMeasure: number;
  secPerMeasure: number;
  timeSigStr: string;
}

export function getMeasureContext(midi: Midi): MeasureContext {
  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  const ts = (midi.header.timeSignatures[0]?.timeSignature ?? [4, 4]) as [number, number];
  const beatsPerMeasure = ts[0] * (4 / ts[1]);
  const secPerMeasure = beatsPerMeasure * (60 / bpm);
  return {
    bpm,
    timeSig: ts,
    beatsPerMeasure,
    secPerMeasure,
    timeSigStr: `${ts[0]}/${ts[1]}`,
  };
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
        trackIndex,
        vexKey: noteToVexKey(n),
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

export interface VoiceAtom {
  keys: string[];
  duration: string;
  dots?: number;
  rest?: boolean;
}

/** 从大到小贪心拆分；须含 64 分音符，避免剩余时值强行写成 16 分导致总拍数大于真实时值 */
const DUR_ROWS: { beats: number; code: string }[] = [
  { beats: 4, code: 'w' },
  { beats: 2, code: 'h' },
  { beats: 1, code: 'q' },
  { beats: 0.5, code: '8' },
  { beats: 0.25, code: '16' },
  { beats: 0.125, code: '32' },
  { beats: 0.0625, code: '64' },
];

function decomposeBeats(beats: number): { duration: string; dots?: number }[] {
  let left = Math.max(0, Math.round(beats * 64) / 64);
  const out: { duration: string; dots?: number }[] = [];
  for (const row of DUR_ROWS) {
    while (left >= row.beats - 1e-5) {
      out.push({ duration: row.code });
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
  const start = measureIndex * ctx.secPerMeasure;
  const end = start + ctx.secPerMeasure;
  const slices: SliceNote[] = [];
  for (const n of flat) {
    if (assignHandForNote(n, midi) !== hand) continue;
    const sl = clipNote(n, start, end, ctx.bpm);
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
  const dur = midi.duration;
  return Math.max(1, Math.ceil(dur / ctx.secPerMeasure - 1e-6));
}
