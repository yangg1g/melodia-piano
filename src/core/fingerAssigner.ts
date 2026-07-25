/**
 * 钢琴指法自动分配引擎
 *
 * 基于音高范围与手的自然位置，为每个音符自动分配手指编号（1-5）。
 * 右手：拇指(1)=低音 → 小指(5)=高音
 * 左手：小指(5)=低音 → 拇指(1)=高音
 */
import { assignHandForNote, type FlatNote, type Hand } from './midiScore';
import type { Midi } from '@tonejs/midi';

/** 黑键 MIDI 音级（mod 12） */
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

function isBlack(midi: number): boolean {
  return BLACK_KEYS.has(midi % 12);
}

export interface FingerResult {
  /** MIDI 音高 → 手指编号 (1-5) */
  midiToFinger: Map<number, number>;
  /** 按时间的指法分配（key = `${midi}:${time.toFixed(3)}`） */
  timeFinger: Map<string, number>;
}

/**
 * 为一组音符自动分配指法。
 * - 按手部分组，分别处理
 * - 基于音域确定手位，避免拇指上黑键
 * - 和弦内从低到高依次分配手指
 */
export function autoAssignFingers(
  flatNotes: FlatNote[],
  midiFile: Midi,
): FingerResult {
  const midiToFinger = new Map<number, number>();
  const timeFinger = new Map<string, number>();

  // 按手部分组
  const trebleNotes: FlatNote[] = [];
  const bassNotes: FlatNote[] = [];
  for (const n of flatNotes) {
    const hand = assignHandForNote(n, midiFile);
    if (hand === 'treble') trebleNotes.push(n);
    else bassNotes.push(n);
  }

  // 分别处理每个手部
  assignHandFingers(trebleNotes, 'treble', midiToFinger, timeFinger);
  assignHandFingers(bassNotes, 'bass', midiToFinger, timeFinger);

  return { midiToFinger, timeFinger };
}

function assignHandFingers(
  notes: FlatNote[],
  hand: Hand,
  midiToFinger: Map<number, number>,
  timeFinger: Map<string, number>,
): void {
  if (notes.length === 0) return;

  // 按时间分组（同一时刻的音符为和弦）
  const timeGroups = new Map<number, FlatNote[]>();
  for (const n of notes) {
    const bucket = Math.round(n.time * 100) / 100; // 精度 10ms
    const arr = timeGroups.get(bucket) ?? [];
    arr.push(n);
    timeGroups.set(bucket, arr);
  }

  // 按时间排序
  const sortedTimes = [...timeGroups.keys()].sort((a, b) => a - b);

  // 分析音高范围
  const allMidis = notes.map(n => n.midi);
  const minMidi = Math.min(...allMidis);
  const maxMidi = Math.max(...allMidis);

  // 确定整体手位范围
  const range = maxMidi - minMidi;

  for (const time of sortedTimes) {
    const chord = timeGroups.get(time)!;
    // 和弦内按音高排序
    chord.sort((a, b) => a.midi - b.midi);

    // 分析当前和弦的音域
    const chordMin = Math.min(...chord.map(n => n.midi));
    const chordMax = Math.max(...chord.map(n => n.midi));
    const chordSpan = chordMax - chordMin;

    if (chord.length === 1) {
      // 单音：根据在整个手部音域中的位置分配
      const midi = chord[0].midi;
      const finger = fingerForMidi(midi, minMidi, maxMidi, hand);
      const key = makeTimeKey(midi, chord[0].time);
      midiToFinger.set(midi, finger);
      timeFinger.set(key, finger);
    } else if (chordSpan <= 7) {
      // 密集和弦（五度以内）：从低到高分配连续手指
      for (let i = 0; i < chord.length; i++) {
        // 根据和弦在整体音域中的位置偏移
        const offset = Math.round((chordMin - minMidi) / Math.max(1, range) * 3);
        let finger: number;
        if (hand === 'treble') {
          finger = Math.max(1, Math.min(5, 1 + offset + i));
        } else {
          finger = Math.max(1, Math.min(5, 5 - offset - i));
        }
        // 避免拇指(1)在黑键上
        if (finger === 1 && isBlack(chord[i].midi) && chord.length > 1) {
          finger = 2;
        }
        const key = makeTimeKey(chord[i].midi, chord[i].time);
        midiToFinger.set(chord[i].midi, finger);
        timeFinger.set(key, finger);
      }
    } else {
      // 宽音程和弦：每个音独立分配
      for (const n of chord) {
        const finger = fingerForMidi(n.midi, minMidi, maxMidi, hand);
        const key = makeTimeKey(n.midi, n.time);
        midiToFinger.set(n.midi, finger);
        timeFinger.set(key, finger);
      }
    }
  }
}

/**
 * 根据音高在音域中的位置计算手指编号
 */
function fingerForMidi(midi: number, minMidi: number, maxMidi: number, hand: Hand): number {
  const range = Math.max(1, maxMidi - minMidi);
  const ratio = (midi - minMidi) / range; // 0=最低, 1=最高

  let finger: number;
  if (hand === 'treble') {
    // 右手：低音→拇指(1)，高音→小指(5)
    finger = Math.round(1 + ratio * 4);
  } else {
    // 左手：低音→小指(5)，高音→拇指(1)
    finger = Math.round(5 - ratio * 4);
  }

  finger = Math.max(1, Math.min(5, finger));

  // 避免拇指在黑键上
  if (finger === 1 && isBlack(midi)) {
    // 移到食指
    finger = 2;
  }

  return finger;
}

function makeTimeKey(midi: number, time: number): string {
  return `${midi}:${time.toFixed(3)}`;
}
