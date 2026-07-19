/**
 * 历史成绩持久化
 */
import type { PlayHistoryEntry } from '../core/types';

const HISTORY_KEY = 'midi-piano-history';

export function loadHistory(): PlayHistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

export function addHistoryEntry(entry: PlayHistoryEntry): void {
  const all = loadHistory();
  all.push(entry);
  if (all.length > 500) all.splice(0, all.length - 500);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
}

export function clearAllHistory(): void {
  localStorage.removeItem(HISTORY_KEY);
}

export function deleteHistoryEntry(songFile: string, date: string): boolean {
  const all = loadHistory();
  const idx = all.findIndex(e => e.songFile === songFile && e.date === date);
  if (idx !== -1) {
    all.splice(idx, 1);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
    return true;
  }
  return false;
}

export function getBestForSong(songFile: string): { bestScore: number; bestAccuracy: number; bestCombo: number; totalPlays: number } | null {
  const entries = loadHistory().filter(e => e.songFile === songFile);
  if (entries.length === 0) return null;
  let bestScore = 0, bestAccuracy = 0, bestCombo = 0;
  for (const e of entries) {
    if (e.score > bestScore) bestScore = e.score;
    if (e.accuracy > bestAccuracy) bestAccuracy = e.accuracy;
    if (e.maxCombo > bestCombo) bestCombo = e.maxCombo;
  }
  return { bestScore, bestAccuracy, bestCombo, totalPlays: entries.length };
}

export function getHistoryForSong(songFile: string): PlayHistoryEntry[] {
  return loadHistory().filter(e => e.songFile === songFile).sort((a, b) => b.score - a.score);
}
