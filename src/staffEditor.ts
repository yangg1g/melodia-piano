/**
 * 五线谱编辑模式：手指编号 + 连音符号
 */

import { assignHandForNote, type FlatNote, type Hand, type MeasureContext, type VoiceAtom } from './midiScore';

/** 音符的唯一标识：`小节序号:谱表:VoiceAtom序号:键序号` */
export type NoteKey = string;

export function makeNoteKey(
  measureIdx: number,
  hand: Hand,
  atomIdx: number,
  keyIdx: number,
): NoteKey {
  return `${measureIdx}:${hand}:${atomIdx}:${keyIdx}`;
}

export function parseNoteKey(key: NoteKey): { measureIdx: number; hand: Hand; atomIdx: number; keyIdx: number } {
  const [m, h, a, k] = key.split(':');
  return { measureIdx: Number(m), hand: h as Hand, atomIdx: Number(a), keyIdx: Number(k) };
}

/** 编辑状态 */
export interface StaffEditState {
  /** 手指编号（1-5） */
  fingerNumbers: Map<NoteKey, number>;
  /** 连音线（从 → 到） */
  slurs: Array<{ from: NoteKey; to: NoteKey }>;
  /** 连尾（从 → 到） */
  ties: Array<{ from: NoteKey; to: NoteKey }>;
  /** 符尾方向：1=向上，-1=向下 */
  stemDirections: Map<NoteKey, 1 | -1>;
}

/** 创建一个空编辑状态 */
export function createStaffEditState(): StaffEditState {
  return { fingerNumbers: new Map(), slurs: [], ties: [], stemDirections: new Map() };
}

/**
 * 编辑模式工具类型
 * - 'select': 选择/设置指法
 * - 'slur':  添加连音线
 * - 'tie':   添加连尾
 */
export type EditTool = 'select' | 'slur' | 'tie';

/**
 * 将编辑状态序列化为 JSON（用于保存/恢复）
 */
export function serializeEditState(state: StaffEditState): string {
  const fArr: [string, number][] = [];
  state.fingerNumbers.forEach((v, k) => fArr.push([k, v]));
  const sdArr: [string, number][] = [];
  state.stemDirections.forEach((v, k) => sdArr.push([k, v]));
  return JSON.stringify({ fingerNumbers: fArr, slurs: state.slurs, ties: state.ties, stemDirections: sdArr });
}

export function deserializeEditState(json: string): StaffEditState {
  try {
    const raw = JSON.parse(json);
    const sdEntries: [string, 1 | -1][] = (raw.stemDirections ?? []).map(
      ([k, v]: [string, number]) => [k, v as 1 | -1],
    );
    return {
      fingerNumbers: new Map<NoteKey, number>(raw.fingerNumbers ?? []),
      slurs: raw.slurs ?? [],
      ties: raw.ties ?? [],
      stemDirections: new Map<NoteKey, 1 | -1>(sdEntries),
    };
  } catch {
    return createStaffEditState();
  }
}

/** 克隆编辑状态 */
export function cloneEditState(state: StaffEditState): StaffEditState {
  return {
    fingerNumbers: new Map(state.fingerNumbers),
    slurs: state.slurs.map((s) => ({ ...s })),
    ties: state.ties.map((t) => ({ ...t })),
    stemDirections: new Map(state.stemDirections),
  };
}

/**
 * 根据测量序号和谱表收集该小节内的 "NoteKey → 原子索引" 映射，
 * 用于在点击事件中将 NoteKey 映射回渲染上下文。
 */
export interface NoteKeyMapEntry {
  noteKey: NoteKey;
  atomIdx: number;
  keyIdx: number;
  midi: number;
}

export function buildNoteKeyMap(
  flatNotes: FlatNote[],
  midiFile: { durationTicks: number },
  ctx: MeasureContext,
  measureIdx: number,
  hand: Hand,
  atoms: VoiceAtom[],
): NoteKeyMapEntry[] {
  const result: NoteKeyMapEntry[] = [];
  for (let ai = 0; ai < atoms.length; ai++) {
    const atom = atoms[ai];
    if (atom.rest) continue;
    for (let ki = 0; ki < atom.keys.length; ki++) {
      const key = atom.keys[ki];
      // 在 flatNotes 中查找对应的 MIDI 音高（简化：用 key 匹配）
      const flat = findFlatForKey(flatNotes, midiFile, ctx, measureIdx, hand, atom, ki, key);
      result.push({
        noteKey: makeNoteKey(measureIdx, hand, ai, ki),
        atomIdx: ai,
        keyIdx: ki,
        midi: flat?.midi ?? 60,
      });
    }
  }
  return result;
}

function findFlatForKey(
  flatNotes: FlatNote[],
  midiFile: { durationTicks: number },
  ctx: MeasureContext,
  measureIdx: number,
  hand: Hand,
  atom: VoiceAtom,
  keyIdx: number,
  vexKey: string,
): FlatNote | undefined {
  // 根据 VexFlow key 反查 midi 音高
  const midiInC4 = vexKeyToMidi(vexKey);
  const measureStartTick = measureIdx * ctx.ticksPerMeasure;
  const measureEndTick = (measureIdx + 1) * ctx.ticksPerMeasure;

  return flatNotes.find((fn) => {
    if (Math.abs((fn.midi % 12) - (midiInC4 % 12)) > 0) return false;
    if (fn.ticks < measureStartTick || fn.ticks >= measureEndTick) return false;
    if (assignHandForNote(fn, midiFile as any) !== hand) return false;
    return true;
  });
}

/** 将 VexFlow 键名（如 "c/4"）转换为 MIDI 号（近似） */
function vexKeyToMidi(vexKey: string): number {
  const match = vexKey.match(/^([a-g])([#b]?)\/(\d+)$/);
  if (!match) return 60;
  const [, note, acc, octStr] = match;
  const oct = parseInt(octStr, 10);
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[note] ?? 0;
  const alter = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
  return oct * 12 + base + alter;
}
