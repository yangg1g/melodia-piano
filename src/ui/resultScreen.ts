/**
 * 结果结算页面
 */
import type { PlayHistoryEntry } from '../core/types';
import { formatTime } from './progressBar';

export interface ResultPageElements {
  page: HTMLElement;
  overlay: HTMLElement;
  scoreEl: HTMLSpanElement;
  maxScoreEl: HTMLDivElement;
  accuracyEl: HTMLSpanElement;
  maxComboEl: HTMLSpanElement;
  judgePerfect: HTMLSpanElement;
  judgeOk: HTMLSpanElement;
  judgeMiss: HTMLSpanElement;
  judgeWrong: HTMLSpanElement;
  timingSection: HTMLDivElement;
  timingOriginal: HTMLSpanElement;
  timingActual: HTMLSpanElement;
  timingSlower: HTMLSpanElement;
  chartCanvas: HTMLCanvasElement;
  replayBtn: HTMLButtonElement;
}

export function showResultScreen(
  entry: PlayHistoryEntry,
  maxTheoreticalScore: number,
  elements: ResultPageElements,
  hasReplay = false,
): void {
  const e = entry;

  elements.scoreEl.textContent = e.score.toLocaleString();
  elements.maxScoreEl.textContent = `理论最高 ${maxTheoreticalScore.toLocaleString()}`;

  elements.accuracyEl.textContent = `${(e.accuracy * 100).toFixed(2)}%`;
  elements.maxComboEl.textContent = String(e.maxCombo);
  elements.judgePerfect.textContent = String(e.noteResults?.filter(n => n.judgement === 'PERFECT').length ?? 0);
  elements.judgeOk.textContent = String(e.noteResults?.filter(n => n.judgement === 'OK').length ?? 0);
  elements.judgeMiss.textContent = String(e.noteResults?.filter(n => n.judgement === 'MISS').length ?? 0);
  elements.judgeWrong.textContent = String(e.wrongKeyRecords?.length ?? 0);

  // 跟弹模式：显示用时比较
  const isKeyboardMode = e.mode === 'keyboard';
  if (isKeyboardMode && e.wallTimeSec && e.wallTimeSec > 0 && e.originalDurationSec && e.originalDurationSec > 0) {
    elements.timingSection.hidden = false;
    elements.timingOriginal.textContent = formatTime(e.originalDurationSec);
    elements.timingActual.textContent = formatTime(e.wallTimeSec);
    const pct = (e.wallTimeSec / e.originalDurationSec) * 100;
    elements.timingSlower.textContent = `${pct.toFixed(1)}%`;
  } else {
    elements.timingSection.hidden = true;
  }

  // 绘制判定时间线
  requestAnimationFrame(() => {
    renderTimelineToCanvas(elements.chartCanvas, e);
  });

  elements.overlay.hidden = false;
  elements.page.hidden = false;
  elements.replayBtn.hidden = !hasReplay;
}

export function hideResultScreen(elements: ResultPageElements): void {
  elements.page.hidden = true;
  elements.overlay.hidden = true;
}

function renderTimelineToCanvas(canvas: HTMLCanvasElement, entry: PlayHistoryEntry): void {
  const notes = entry.noteResults ?? [];
  const wrongs = entry.wrongKeyRecords ?? [];
  const dpr = window.devicePixelRatio || 1;

  let maxTime = 0;
  for (const n of notes) maxTime = Math.max(maxTime, n.time);
  for (const w of wrongs) maxTime = Math.max(maxTime, w.timeSec);
  if (maxTime <= 0) maxTime = 60;
  const duration = maxTime + 2;

  const w = canvas.parentElement!.clientWidth;
  const h = 200;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#f8f9fb';
  ctx.fillRect(0, 0, w, h);

  const padding = { top: 16, right: 16, bottom: 24, left: 36 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;
  const timeToX = (t: number) => padding.left + (t / duration) * plotW;

  ctx.strokeStyle = '#e8ecf0';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (i / 5) * plotH;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
  }

  const midiMin = 21;
  const midiMax = 108;
  const midiToY = (midi: number) => {
    const ratio = 1 - (midi - midiMin) / (midiMax - midiMin);
    return padding.top + ratio * plotH;
  };

  const barH = Math.max(2, (plotH / 88) * 3);
  for (const n of notes) {
    const x = timeToX(n.time);
    const y = midiToY(n.midi) - barH / 2;
    let color: string;
    if (n.judgement === 'PERFECT') color = '#fbbf24';
    else if (n.judgement === 'OK') color = '#a78bfa';
    else color = '#ef4444';

    ctx.fillStyle = color;
    ctx.fillRect(x, y, Math.max(3, w / 400), barH);
  }

  for (const w of wrongs) {
    const x = timeToX(w.timeSec);
    const y = midiToY(w.midi);
    ctx.fillStyle = '#f87171';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#6b7280';
  ctx.font = '10px system-ui';
  for (let t = 0; t <= duration; t += Math.ceil(duration / 6)) {
    const x = timeToX(t);
    ctx.fillText(t < 60 ? `${t}s` : `${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, '0')}`, x - 12, h - 6);
  }
}
