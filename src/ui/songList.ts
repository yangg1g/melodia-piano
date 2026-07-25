/**
 * 歌曲列表 UI：加载、渲染、预览
 */
import { getBestForSong, getHistoryForSong, deleteHistoryEntry } from './history';
import { ensurePiano, playPianoMidi, releaseAllPiano } from '../audio/salamanderPiano';

export interface SongListElements {
  container: HTMLDivElement;
  fileInput: HTMLInputElement;
  practiceBtn: HTMLButtonElement;
  historyList: HTMLDivElement;
}

let previewTimers: number[] = [];
let previewCancelled = false;

export async function fetchSongList(): Promise<string[]> {
  const res = await fetch('/api/songs');
  return res.json();
}

export function renderStars(rating: number): string {
  const full = Math.floor(rating);
  const frac = rating - full;
  let html = '';
  for (let i = 0; i < full; i++) html += '★';
  if (frac >= 0.5) html += '☆';
  if (html === '') return '-';
  const numeric = rating > 0 ? ` (${rating.toFixed(1)})` : '';
  return `<span class="star-display">${html}${numeric}</span>`;
}

/** refresh history panel */
export function updateHistoryPanel(
  songFile: string | null,
  songFiles: string[],
  historyListEl: HTMLElement,
  callbacks: {
    onShowResult: (entry: ReturnType<typeof getHistoryForSong>[number]) => void;
    onShowConfirm: (msg: string) => Promise<boolean>;
  },
): void {
  if (!songFile || !songFiles.includes(songFile)) {
    historyListEl.innerHTML = '<div class="history-empty">Select a song to view history</div>';
    return;
  }
  const entries = getHistoryForSong(songFile);
  if (entries.length === 0) {
    historyListEl.innerHTML = '<div class="history-empty">No history for this song</div>';
    return;
  }
  historyListEl.innerHTML = entries.map((e, i) => {
    const date = new Date(e.date);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const modeLabel = e.mode === 'keyboard' ? 'Follow' : e.mode === 'normal' ? 'Normal' : e.mode === 'practice' ? 'Practice' : 'Auto';
    const diffLabel = e.settings.difficulty === 'easy' ? 'Easy' : e.settings.difficulty === 'hard' ? 'Hard' : 'Normal';
    const speedLabel = e.settings.playbackSpeed ? `${e.settings.playbackSpeed.toFixed(1)}x` : '';
    const latestClass = i === 0 ? ' history-entry--latest' : '';
    return `<div class="history-entry${latestClass}" data-song="${e.songFile}" data-date="${e.date}">
      <div class="history-entry-score">${e.score.toLocaleString()}</div>
      <div class="history-entry-meta">
        <span class="history-entry-accu">${(e.accuracy * 100).toFixed(1)}%</span>
        <span class="history-entry-combo">Max ${e.maxCombo}</span>
      </div>
      <div class="history-entry-mode">
        <span>${modeLabel}</span>
        ${speedLabel ? `<span class="history-entry-speed">${speedLabel}</span>` : ''}
        <span class="history-entry-diff">${diffLabel}</span>
      </div>
      <div class="history-entry-date">${dateStr}</div>
    </div>`;
  }).join('');

  // click to view result / right-click to delete
  historyListEl.querySelectorAll<HTMLElement>('.history-entry').forEach((el, i) => {
    el.addEventListener('click', () => {
      const entry = entries[i];
      if (entry) callbacks.onShowResult(entry);
    });
    el.addEventListener('contextmenu', async (ev) => {
      ev.preventDefault();
      const song = el.dataset.song!;
      const date = el.dataset.date!;
      const scoreText = el.querySelector('.history-entry-score')?.textContent ?? '';
      const ok = await callbacks.onShowConfirm(`Delete this score (${scoreText})?`);
      if (ok) {
        deleteHistoryEntry(song, date);
        updateHistoryPanel(songFile, songFiles, historyListEl, callbacks);
      }
    });
  });
}

/** refresh best score display for a song (do not rebuild list) */
export function refreshSongBest(songFile: string, songListEl: HTMLElement): void {
  const best = getBestForSong(songFile);
  const items = songListEl.querySelectorAll<HTMLElement>('.song-list-item');
  for (const item of items) {
    if (item.dataset.file !== songFile) continue;
    const historySpan = item.querySelector('.song-list-history');
    if (best) {
      const html = `Best <span class="history-score">${best.bestScore.toLocaleString()}</span> | ${(best.bestAccuracy * 100).toFixed(1)}% | ${best.totalPlays} plays`;
      if (historySpan) historySpan.innerHTML = html;
      else {
        const span = document.createElement('span');
        span.className = 'song-list-history';
        span.innerHTML = html;
        item.querySelector('.song-list-meta')?.appendChild(span);
      }
    }
  }
}

/** Hover preview */
export async function startPreview(filename: string): Promise<void> {
  stopPreview();
  previewCancelled = false;

  try {
    await ensurePiano();
    const res = await fetch(`/songs/json/${encodeURIComponent(filename)}`);
    if (!res.ok || previewCancelled) return;
    const json = await res.json();
    if (previewCancelled) return;

    const PREVIEW_SEC = 8;
    for (const note of json.notes) {
      if (note.time > PREVIEW_SEC) continue;
      if (previewCancelled) return;
      const delayMs = note.time * 1000;
      const dur = Math.max(0.05, note.duration);
      const vel = note.velocity ?? 0.78;
        const id = window.setTimeout(() => {
          if (previewCancelled) return;
          playPianoMidi(note.midi, dur, vel);
        }, delayMs);
        previewTimers.push(id);
      }
  } catch {
    // preview failure silently
  }
}

export function stopPreview(): void {
  previewCancelled = true;
  for (const id of previewTimers) clearTimeout(id);
  previewTimers = [];
  releaseAllPiano();
}
