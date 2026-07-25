/**
 * 项目共享类型定义
 */
import type { NoteResult, WrongKeyRecord } from './scoring';

export type PlayMode = 'normal' | 'auto' | 'keyboard';

export interface AppSettings {
  mode: PlayMode;
  fallingSpeed: number;
  playbackSpeed: number;
  difficulty: 'easy' | 'normal' | 'hard';
  renderMode: 'image' | 'original';
  measureWidth: number;
  /** 全局判定偏移（ms），正=提前补偿（判定偏晚），负=延迟补偿（判定偏早） */
  offsetAdjustMs: number;
  /** 和弦显示语言 */
  chordLang: 'zh' | 'en';
}

export interface PlayHistoryEntry {
  songFile: string;
  songName: string;
  score: number;
  accuracy: number;
  maxCombo: number;
  mode: string;
  date: string;
  settings: {
    fallingSpeed: number;
    playbackSpeed: number;
    difficulty: string;
    offsetAdjustMs?: number;
  };
  noteResults?: NoteResult[];
  wrongKeyRecords?: WrongKeyRecord[];
  wallTimeSec?: number;
  originalDurationSec?: number;
  /** 回放用的 MIDI 事件（序列化格式：[dataBytes, wallTimeSec]） */
  recordedEvents?: Array<{ data: number[]; wallTimeSec: number }>;
}

export interface PracticeLoopRecord {
  round: number;
  score: number;
  maxScore: number;
  accuracy: number;
  elapsedSec: number;
  loopDurationSec: number;
  counts: Record<string, number>;
  noteResults: NoteResult[];
  wrongKeyRecords: WrongKeyRecord[];
}

export const DIFFICULTY_WINDOWS: Record<AppSettings['difficulty'], { label: string; windows: { perfect: number; ok: number; bad: number } }> = {
  easy: {
    label: 'PERFECT ≤ 40ms · OK ≤ 260ms · BAD ≤ 340ms',
    windows: { perfect: 40, ok: 260, bad: 340 },
  },
  normal: {
    label: 'PERFECT ≤ 25ms · OK ≤ 180ms · BAD ≤ 260ms',
    windows: { perfect: 25, ok: 180, bad: 260 },
  },
  hard: {
    label: 'PERFECT ≤ 15ms · OK ≤ 120ms · BAD ≤ 180ms',
    windows: { perfect: 15, ok: 120, bad: 180 },
  },
};
