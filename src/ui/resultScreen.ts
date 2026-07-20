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
  judgeBad: HTMLSpanElement;
  judgeMiss: HTMLSpanElement;
  judgeWrong: HTMLSpanElement;
  timingSection: HTMLDivElement;
  timingOriginal: HTMLSpanElement;
  timingActual: HTMLSpanElement;
  timingSlower: HTMLSpanElement;
  chartCanvas: HTMLCanvasElement;
  errorCurveCanvas: HTMLCanvasElement;
  avgErrorEl: HTMLSpanElement;
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
  elements.judgeBad.textContent = String(e.noteResults?.filter(n => n.judgement === 'BAD').length ?? 0);
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

  // 绘制误差曲线
  requestAnimationFrame(() => {
    const avg = renderErrorCurveToCanvas(elements.errorCurveCanvas, e);
    elements.avgErrorEl.textContent = `平均偏差 ${avg.toFixed(1)}ms`;
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
    else if (n.judgement === 'BAD') color = '#fb923c';
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

/** 绘制误差曲线（offsetMs 随音符序号变化），返回平均偏差 */
function renderErrorCurveToCanvas(canvas: HTMLCanvasElement, entry: PlayHistoryEntry): number {
  const notes = entry.noteResults ?? [];
  if (notes.length === 0) return 0;

  // 应用整体偏移补偿
  const adjustMs = entry.settings?.offsetAdjustMs ?? 0;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement!.clientWidth;
  const h = 180;
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

  // Y 轴范围：± 200ms，或根据实际数据动态扩展
  const offsets = notes.filter(n => n.judgement !== 'MISS').map(n => n.offsetMs - adjustMs);
  let maxAbs = 200;
  for (const o of offsets) maxAbs = Math.max(maxAbs, Math.abs(o));
  maxAbs = Math.ceil(maxAbs / 50) * 50;

  const yToPx = (offsetMs: number) => padding.top + plotH / 2 - (offsetMs / maxAbs) * (plotH / 2);
  const xToPx = (i: number) => padding.left + (i / Math.max(1, notes.length - 1)) * plotW;

  // 网格线
  ctx.strokeStyle = '#e8ecf0';
  ctx.lineWidth = 1;
  for (let o = -maxAbs; o <= maxAbs; o += maxAbs / 4) {
    const y = yToPx(o);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
  }

  // 零线
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  const zeroY = yToPx(0);
  ctx.moveTo(padding.left, zeroY);
  ctx.lineTo(padding.left + plotW, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 绘制误差散点 + 连线
  const points: Array<{ x: number; y: number; offsetMs: number; judgement: string }> = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.judgement === 'MISS') continue;
    const adjMs = n.offsetMs - adjustMs;
    points.push({ x: xToPx(i), y: yToPx(adjMs), offsetMs: adjMs, judgement: n.judgement });
  }

  if (points.length > 0) {
    // 连线
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // 散点
    for (const p of points) {
      let color: string;
      if (p.judgement === 'PERFECT') color = '#fbbf24';
      else if (p.judgement === 'OK') color = '#a78bfa';
      else if (p.judgement === 'BAD') color = '#fb923c';
      else color = '#ef4444';
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 平均线
    const sumOffsets = offsets.reduce((a, b) => a + b, 0);
    const avgOffset = offsets.length > 0 ? sumOffsets / offsets.length : 0;
    const avgY = yToPx(avgOffset);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(padding.left, avgY);
    ctx.lineTo(padding.left + plotW, avgY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Y 轴标签
  ctx.fillStyle = '#6b7280';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'right';
  for (let o = -maxAbs; o <= maxAbs; o += maxAbs / 4) {
    const y = yToPx(o);
    ctx.fillText(`${Math.round(o)}ms`, padding.left - 4, y + 3);
  }
  ctx.textAlign = 'start';

  // 计算平均偏差
  const sum = offsets.reduce((a, b) => a + b, 0);
  return offsets.length > 0 ? sum / offsets.length : 0;
}
