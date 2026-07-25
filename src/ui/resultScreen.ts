/**
 * 结果结算页面
 */
import type { PlayHistoryEntry } from '../core/types';
import { formatTime } from './progressBar';

/** 渲染辅助：读取当前主题配色 */
function getChartTheme() {
  const s = getComputedStyle(document.body);
  return {
    bg: s.getPropertyValue('--bg-secondary').trim() || '#f1f3f6',
    surface: s.getPropertyValue('--surface').trim() || '#ffffff',
    border: s.getPropertyValue('--border').trim() || '#e5e3ed',
    text: s.getPropertyValue('--text').trim() || '#1c1b22',
    muted: s.getPropertyValue('--muted').trim() || '#6b6978',
    accent: s.getPropertyValue('--accent').trim() || '#4f6ef7',
  };
}

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
  accuracyCurveCanvas: HTMLCanvasElement;
  avgErrorEl: HTMLSpanElement;
  accuracyCurveInfoEl: HTMLSpanElement;
  timeRatioSection: HTMLDivElement;
  timeRatioCanvas: HTMLCanvasElement;
  timeRatioInfoEl: HTMLSpanElement;
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

  // 绘制实时准度曲线
  requestAnimationFrame(() => {
    renderAccuracyCurveToCanvas(elements.accuracyCurveCanvas, e, elements.accuracyCurveInfoEl);
  });

  // 绘制用时占比曲线（跟弹模式）
  if (e.timeRatioPoints && e.timeRatioPoints.length > 0) {
    elements.timeRatioSection.hidden = false;
    requestAnimationFrame(() => {
      renderTimeRatioToCanvas(elements.timeRatioCanvas, e, elements.timeRatioInfoEl);
    });
  } else {
    elements.timeRatioSection.hidden = true;
  }

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
  const t = getChartTheme();

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

  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, w, h);

  const padding = { top: 16, right: 16, bottom: 24, left: 36 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;
  const timeToX = (v: number) => padding.left + (v / duration) * plotW;

  ctx.strokeStyle = t.border;
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
    ctx.fillStyle = n.judgement === 'PERFECT' ? '#f59e0b' : n.judgement === 'OK' ? '#8b5cf6' : n.judgement === 'BAD' ? '#f97316' : '#ef4444';
    ctx.fillRect(x, y, Math.max(3, w / 400), barH);
  }

  for (const w of wrongs) {
    const x = timeToX(w.timeSec);
    const y = midiToY(w.midi);
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = t.muted;
  ctx.font = '10px system-ui';
  for (let i = 0; i <= duration; i += Math.ceil(duration / 6)) {
    const x = timeToX(i);
    ctx.fillText(i < 60 ? `${i}s` : `${Math.floor(i / 60)}:${(i % 60).toString().padStart(2, '0')}`, x - 12, h - 6);
  }
}

/** 绘制误差曲线（offsetMs 随音符序号变化），返回平均偏差 */
function renderErrorCurveToCanvas(canvas: HTMLCanvasElement, entry: PlayHistoryEntry): number {
  const notes = entry.noteResults ?? [];
  if (notes.length === 0) return 0;

  const adjustMs = entry.settings?.offsetAdjustMs ?? 0;
  const t = getChartTheme();

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement!.clientWidth;
  const h = 180;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, w, h);

  const padding = { top: 16, right: 16, bottom: 24, left: 36 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const offsets = notes.map(n => n.offsetMs - adjustMs);
  let maxAbs = 200;
  for (const o of offsets) maxAbs = Math.max(maxAbs, Math.abs(o));
  maxAbs = Math.ceil(maxAbs / 50) * 50;

  const yToPx = (offsetMs: number) => padding.top + plotH / 2 - (offsetMs / maxAbs) * (plotH / 2);
  const xToPx = (i: number) => padding.left + (i / Math.max(1, notes.length - 1)) * plotW;

  // 网格线
  ctx.strokeStyle = t.border;
  ctx.lineWidth = 1;
  for (let o = -maxAbs; o <= maxAbs; o += maxAbs / 4) {
    const y = yToPx(o);
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(padding.left + plotW, y); ctx.stroke();
  }

  // 零线
  ctx.strokeStyle = t.muted;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  const zeroY = yToPx(0);
  ctx.beginPath(); ctx.moveTo(padding.left, zeroY); ctx.lineTo(padding.left + plotW, zeroY); ctx.stroke();
  ctx.setLineDash([]);

  const points: Array<{ x: number; y: number; offsetMs: number; judgement: string }> = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const adjMs = n.offsetMs - adjustMs;
    points.push({ x: xToPx(i), y: yToPx(adjMs), offsetMs: adjMs, judgement: n.judgement });
  }

  if (points.length > 0) {
    ctx.strokeStyle = t.border;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();

    for (const p of points) {
      ctx.fillStyle = p.judgement === 'PERFECT' ? '#f59e0b' : p.judgement === 'OK' ? '#8b5cf6' : p.judgement === 'BAD' ? '#f97316' : '#ef4444';
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    const sumOffsets = offsets.reduce((a, b) => a + b, 0);
    const avgOffset = offsets.length > 0 ? sumOffsets / offsets.length : 0;
    const avgY = yToPx(avgOffset);
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath(); ctx.moveTo(padding.left, avgY); ctx.lineTo(padding.left + plotW, avgY); ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = t.muted;
  ctx.font = '9px system-ui';
  ctx.textAlign = 'right';
  for (let o = -maxAbs; o <= maxAbs; o += maxAbs / 4) {
    const y = yToPx(o);
    ctx.fillText(`${Math.round(o)}ms`, padding.left - 4, y + 3);
  }
  ctx.textAlign = 'start';

  const sum = offsets.reduce((a, b) => a + b, 0);
  return offsets.length > 0 ? sum / offsets.length : 0;
}

/** 绘制实时准度曲线（累计准确率随时间变化），在 infoEl 显示最终值 */
function renderAccuracyCurveToCanvas(
  canvas: HTMLCanvasElement,
  entry: PlayHistoryEntry,
  infoEl: HTMLSpanElement,
): void {
  const notes = entry.noteResults ?? [];
  if (notes.length === 0) { infoEl.textContent = ''; return; }

  const sorted = [...notes].sort((a, b) => a.time - b.time);
  const t = getChartTheme();
  const ACCU_WEIGHT: Record<string, number> = { PERFECT: 320, OK: 150, BAD: 50, MISS: 0 };

  const points: Array<{ time: number; accuracy: number }> = [];
  let achieved = 0, minAcc = 1;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    achieved += ACCU_WEIGHT[n.judgement] ?? 0;
    const acc = achieved / (320 * (i + 1));
    points.push({ time: n.time, accuracy: acc });
    if (acc < minAcc) minAcc = acc;
  }

  const finalAcc = points.length > 0 ? points[points.length - 1].accuracy : 0;
  infoEl.textContent = `累计准度 ${(finalAcc * 100).toFixed(1)}%`;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement!.clientWidth;
  const h = 180;
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, w, h);

  const padding = { top: 16, right: 16, bottom: 24, left: 36 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const yMin = Math.max(0, Math.floor((minAcc * 100 - 5) / 10) * 10);
  const effectiveYRange = Math.max(10, 100 - yMin);

  const maxTime = sorted[sorted.length - 1].time;
  const duration = maxTime + 2;
  const timeToX = (v: number) => padding.left + (v / duration) * plotW;
  const accToY = (a: number) => padding.top + (1 - (a * 100 - yMin) / effectiveYRange) * plotH;

  ctx.strokeStyle = t.border;
  ctx.lineWidth = 1;
  const gridSteps = 5;
  for (let i = 0; i <= gridSteps; i++) {
    const y = accToY((yMin + (i / gridSteps) * effectiveYRange) / 100);
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(padding.left + plotW, y); ctx.stroke();
  }

  ctx.strokeStyle = t.muted;
  ctx.setLineDash([4, 4]);
  const y100 = accToY(1);
  if (y100 >= padding.top) { ctx.beginPath(); ctx.moveTo(padding.left, y100); ctx.lineTo(padding.left + plotW, y100); ctx.stroke(); }
  ctx.setLineDash([]);

  if (points.length > 1) {
    const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
    grad.addColorStop(0, t.accent + '26'); grad.addColorStop(1, t.accent + '05');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(timeToX(points[0].time), padding.top + plotH);
    for (let i = 0; i < points.length; i++) ctx.lineTo(timeToX(points[i].time), accToY(points[i].accuracy));
    ctx.lineTo(timeToX(points[points.length - 1].time), padding.top + plotH);
    ctx.closePath(); ctx.fill();
  }

  if (points.length > 1) {
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(timeToX(points[0].time), accToY(points[0].accuracy));
    for (let i = 1; i < points.length; i++) ctx.lineTo(timeToX(points[i].time), accToY(points[i].accuracy));
    ctx.stroke();

    ctx.fillStyle = t.accent;
    ctx.beginPath(); ctx.arc(timeToX(points[0].time), accToY(points[0].accuracy), 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(timeToX(points[points.length - 1].time), accToY(points[points.length - 1].accuracy), 3, 0, Math.PI * 2); ctx.fill();
  }

  ctx.fillStyle = t.muted;
  ctx.font = '9px system-ui';
  ctx.textAlign = 'right';
  for (let i = 0; i <= gridSteps; i++) {
    const pct = yMin + (i / gridSteps) * effectiveYRange;
    ctx.fillText(`${Math.round(pct)}%`, padding.left - 4, accToY(pct / 100) + 3);
  }
  ctx.textAlign = 'start';

  ctx.fillStyle = t.muted;
  ctx.font = '10px system-ui';
  ctx.textAlign = 'center';
  for (let i = 0; i <= duration; i += Math.ceil(duration / 6)) {
    const x = timeToX(i);
    ctx.fillText(i < 60 ? `${i}s` : `${Math.floor(i / 60)}:${(i % 60).toString().padStart(2, '0')}`, x, h - 6);
  }
  ctx.textAlign = 'start';

  if (minAcc < 0.9) {
    ctx.fillStyle = 'rgba(239,68,68,0.06)';
    ctx.fillRect(padding.left, accToY(0.9), plotW, padding.top + plotH - accToY(0.9));
  }
}

/** 绘制用时占比曲线（结算页面） */
function renderTimeRatioToCanvas(
  canvas: HTMLCanvasElement,
  entry: PlayHistoryEntry,
  infoEl: HTMLSpanElement,
): void {
  const points = entry.timeRatioPoints ?? [];
  if (points.length === 0) { infoEl.textContent = ''; return; }

  const t = getChartTheme();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement!.clientWidth;
  const h = 180;
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, w, h);

  const padding = { top: 16, right: 16, bottom: 24, left: 36 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const maxX = points[points.length - 1].gameSec;
  const maxRatio = Math.max(100, ...points.map(p => p.ratio));

  const timeToX = (v: number) => padding.left + (v / maxX) * plotW;
  const ratioToY = (r: number) => padding.top + (1 - Math.min(r, maxRatio) / maxRatio) * plotH;

  const finalRatio = points.length > 0 ? points[points.length - 1].ratio : 0;
  infoEl.textContent = `最终用时占比 ${finalRatio.toFixed(1)}%`;

  // 网格
  ctx.strokeStyle = t.border;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (i / 5) * plotH;
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(padding.left + plotW, y); ctx.stroke();
  }

  // 100% 线
  const y100 = ratioToY(100);
  ctx.strokeStyle = t.muted;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padding.left, y100); ctx.lineTo(padding.left + plotW, y100); ctx.stroke();
  ctx.setLineDash([]);

  // 填充
  if (points.length > 1) {
    const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
    const color = maxRatio <= 100 ? t.accent : '#ef4444';
    grad.addColorStop(0, color + '30'); grad.addColorStop(1, color + '05');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(timeToX(points[0].gameSec), padding.top + plotH);
    for (const p of points) ctx.lineTo(timeToX(p.gameSec), ratioToY(Math.min(p.ratio, maxRatio)));
    ctx.lineTo(timeToX(points[points.length - 1].gameSec), padding.top + plotH);
    ctx.closePath(); ctx.fill();
  }

  // 曲线
  if (points.length > 1) {
    const color = maxRatio <= 100 ? t.accent : '#ef4444';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(timeToX(points[0].gameSec), ratioToY(Math.min(points[0].ratio, maxRatio)));
    for (const p of points) ctx.lineTo(timeToX(p.gameSec), ratioToY(Math.min(p.ratio, maxRatio)));
    ctx.stroke();
  }

  // Y 标签
  ctx.fillStyle = t.muted;
  ctx.font = '9px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText('100%', padding.left - 4, y100 + 3);
  if (maxRatio !== 100) ctx.fillText(`${Math.round(maxRatio)}%`, padding.left - 4, ratioToY(maxRatio) + 3);
  ctx.textAlign = 'start';

  // X 标签
  ctx.fillStyle = t.muted;
  ctx.font = '10px system-ui';
  for (let i = 0; i <= maxX; i += Math.ceil(maxX / 6)) {
    const x = timeToX(i);
    ctx.fillText(i < 60 ? `${i}s` : `${Math.floor(i / 60)}:${(i % 60).toString().padStart(2, '0')}`, x - 12, h - 6);
  }
}
