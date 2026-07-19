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
  };
  noteResults?: NoteResult[];
  wrongKeyRecords?: WrongKeyRecord[];
  wallTimeSec?: number;
  originalDurationSec?: number;
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

export const DIFFICULTY_WINDOWS: Record<AppSettings['difficulty'], { label: string; windows: { perfect: number; ok: number } }> = {
  easy: {
    label: 'PERFECT ≤ 40ms · OK ≤ 260ms',
    windows: { perfect: 40, ok: 260 },
  },
  normal: {
    label: 'PERFECT ≤ 25ms · OK ≤ 180ms',
    windows: { perfect: 25, ok: 180 },
  },
  hard: {
    label: 'PERFECT ≤ 15ms · OK ≤ 120ms',
    windows: { perfect: 15, ok: 120 },
  },
};
