/**
 * 进度条格式化与更新
 */

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function updateProgressBar(
  bar: HTMLInputElement,
  timeEl: HTMLSpanElement,
  timeSec: number,
  totalDurationSec: number,
  seeking: boolean,
): void {
  if (seeking) return;
  const pct = totalDurationSec > 0 ? (timeSec / totalDurationSec) * 1000 : 0;
  bar.value = String(Math.round(pct));
  timeEl.textContent = `${formatTime(timeSec)} / ${formatTime(totalDurationSec)}`;
}

export function resetProgressBar(
  bar: HTMLInputElement,
  timeEl: HTMLSpanElement,
  totalDurationSec: number,
): void {
  bar.value = '0';
  timeEl.textContent = `0:00 / ${formatTime(totalDurationSec)}`;
}
