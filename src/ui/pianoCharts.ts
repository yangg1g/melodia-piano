/**
 * 实时图表渲染 —— 从 PianoPage 提取的 Canvas 绘制逻辑
 */
import type { PianoPage } from './pianoPage';
import { ACCU_WEIGHT } from '../core/scoring';

/** 读取当前主题配色（适配亮/暗模式） */
export function getChartTheme() {
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

/** 绘制实时准度曲线到左侧面板 Canvas */
export function renderLiveAccuracyChart(page: PianoPage): void {
  const canvas = page.liveAccuracyCanvas;
  const points = page.liveAccuracyPoints;
  const dpr = window.devicePixelRatio || 1;
  const t = getChartTheme();

  const containerW = page.liveAccuracyPanel.clientWidth - 28;
  const h = 138;
  canvas.style.width = `${containerW}px`;
  canvas.style.height = `${h}px`;
  canvas.width = containerW * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  // 背景
  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, containerW, h);

  if (points.length === 0) {
    ctx.fillStyle = t.muted;
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('等待弹奏...', containerW / 2, h / 2);
    ctx.textAlign = 'start';
    return;
  }

  const padding = { top: 8, right: 10, bottom: 16, left: 28 };
  const plotW = containerW - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  let minAcc = 1, maxAcc = 0;
  for (const p of points) { if (p.accuracy < minAcc) minAcc = p.accuracy; if (p.accuracy > maxAcc) maxAcc = p.accuracy; }
  const yMin = Math.max(0, Math.floor((minAcc * 100 - 5) / 10) * 10);
  const effectiveYRange = Math.max(10, 100 - yMin);

  const maxTime = points[points.length - 1].timeSec;
  const duration = Math.max(maxTime + 1, 1);
  const timeToX = (v: number) => padding.left + (v / duration) * plotW;
  const accToY = (a: number) => padding.top + (1 - (a * 100 - yMin) / effectiveYRange) * plotH;

  // 网格
  ctx.strokeStyle = t.border;
  ctx.lineWidth = 0.5;
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const y = accToY((yMin + (i / gridSteps) * effectiveYRange) / 100);
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(padding.left + plotW, y); ctx.stroke();
  }

  // 100% 虚线
  ctx.strokeStyle = t.muted;
  ctx.setLineDash([3, 3]);
  const y100 = accToY(1);
  if (y100 >= padding.top) { ctx.beginPath(); ctx.moveTo(padding.left, y100); ctx.lineTo(padding.left + plotW, y100); ctx.stroke(); }
  ctx.setLineDash([]);

  // 填充
  if (points.length > 1) {
    const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
    grad.addColorStop(0, t.accent + '26');
    grad.addColorStop(1, t.accent + '05');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(timeToX(points[0].timeSec), padding.top + plotH);
    for (const p of points) ctx.lineTo(timeToX(p.timeSec), accToY(p.accuracy));
    ctx.lineTo(timeToX(points[points.length - 1].timeSec), padding.top + plotH);
    ctx.closePath(); ctx.fill();
  }

  // 曲线
  if (points.length > 1) {
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(timeToX(points[0].timeSec), accToY(points[0].accuracy));
    for (const p of points) ctx.lineTo(timeToX(p.timeSec), accToY(p.accuracy));
    ctx.stroke();
  }

  // Y 标签
  ctx.fillStyle = t.muted;
  ctx.font = '8px system-ui';
  ctx.textAlign = 'right';
  for (let i = 0; i <= gridSteps; i++) {
    const pct = yMin + (i / gridSteps) * effectiveYRange;
    ctx.fillText(`${Math.round(pct)}%`, padding.left - 3, accToY(pct / 100) + 3);
  }
  ctx.textAlign = 'start';

  // 低于 90% 警告
  if (minAcc < 0.9) {
    ctx.fillStyle = 'rgba(239,68,68,0.07)';
    ctx.fillRect(padding.left, accToY(0.9), plotW, padding.top + plotH - accToY(0.9));
  }
}

/** 绘制实时判定时间线 */
export function renderLiveTimelineChart(page: PianoPage): void {
  const canvas = page.liveTimelineCanvas;
  const notes = page.scoringEngine.noteResults;
  const wrongs = page.scoringEngine.wrongKeyRecords;
  const dpr = window.devicePixelRatio || 1;
  const t = getChartTheme();

  const containerW = page.liveAccuracyPanel.clientWidth - 28;
  const h = 118;
  canvas.style.width = `${containerW}px`;
  canvas.style.height = `${h}px`;
  canvas.width = containerW * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, containerW, h);

  if (notes.length === 0 && wrongs.length === 0) {
    ctx.fillStyle = t.muted;
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('等待弹奏...', containerW / 2, h / 2);
    ctx.textAlign = 'start';
    return;
  }

  let maxTime = 0;
  for (const n of notes) maxTime = Math.max(maxTime, n.time);
  for (const w of wrongs) maxTime = Math.max(maxTime, w.timeSec);
  if (maxTime <= 0) maxTime = 10;
  const duration = maxTime + 2;

  const padding = { top: 6, right: 4, bottom: 2, left: 4 };
  const plotW = containerW - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;
  const timeToX = (v: number) => padding.left + (v / duration) * plotW;

  const midiMin = 21, midiMax = 108;
  const midiToY = (midi: number) => padding.top + (1 - (midi - midiMin) / (midiMax - midiMin)) * plotH;

  const barH = Math.max(1.2, plotH / 88);
  const barW = Math.max(1.5, containerW / 200);
  for (const n of notes) {
    const x = timeToX(n.time);
    const y = midiToY(n.midi) - barH / 2;
    ctx.fillStyle = n.judgement === 'PERFECT' ? '#f59e0b' : n.judgement === 'OK' ? '#8b5cf6' : n.judgement === 'BAD' ? '#f97316' : '#ef4444';
    ctx.fillRect(x, y, barW, Math.max(1, barH));
  }

  for (const w of wrongs) {
    ctx.fillStyle = '#ef4444';
    ctx.beginPath(); ctx.arc(timeToX(w.timeSec), midiToY(w.midi), 2, 0, Math.PI * 2); ctx.fill();
  }
}

/** 绘制实时按键偏差散点 */
export function renderLiveErrorChart(page: PianoPage): void {
  const canvas = page.liveErrorCanvas;
  const notes = page.scoringEngine.noteResults;
  const dpr = window.devicePixelRatio || 1;
  const t = getChartTheme();

  const containerW = page.liveAccuracyPanel.clientWidth - 28;
  const h = 118;
  canvas.style.width = `${containerW}px`;
  canvas.style.height = `${h}px`;
  canvas.width = containerW * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, containerW, h);

  if (notes.length === 0) {
    ctx.fillStyle = t.muted;
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('等待弹奏...', containerW / 2, h / 2);
    ctx.textAlign = 'start';
    return;
  }

  const adjustMs = page.scoringEngine.offsetAdjustMs;
  const offsets = notes.map(n => n.offsetMs - adjustMs);
  let maxAbs = 200;
  for (const o of offsets) maxAbs = Math.max(maxAbs, Math.abs(o));
  maxAbs = Math.ceil(maxAbs / 50) * 50;

  const padding = { top: 8, right: 6, bottom: 2, left: 26 };
  const plotW = containerW - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;
  const yToPx = (o: number) => padding.top + plotH / 2 - (o / maxAbs) * (plotH / 2);

  ctx.strokeStyle = t.muted;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([3, 3]);
  const zeroY = yToPx(0);
  ctx.beginPath(); ctx.moveTo(padding.left, zeroY); ctx.lineTo(padding.left + plotW, zeroY); ctx.stroke();
  ctx.setLineDash([]);

  const maxTime = notes[notes.length - 1].time;
  const duration = Math.max(maxTime + 1, 1);
  const timeToX = (v: number) => padding.left + (v / duration) * plotW;

  for (const n of notes) {
    const adjMs = n.offsetMs - adjustMs;
    ctx.fillStyle = n.judgement === 'PERFECT' ? '#f59e0b' : n.judgement === 'OK' ? '#8b5cf6' : n.judgement === 'BAD' ? '#f97316' : '#ef4444';
    ctx.beginPath(); ctx.arc(timeToX(n.time), yToPx(adjMs), 2, 0, Math.PI * 2); ctx.fill();
  }

  // 平均偏差线
  const avgMs = offsets.length > 0 ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 0;
  const avgY = yToPx(avgMs);
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(padding.left, avgY); ctx.lineTo(padding.left + plotW, avgY); ctx.stroke();
  ctx.setLineDash([]);

  // Y 标签 (±ms)
  ctx.fillStyle = t.muted;
  ctx.font = '7px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText(`+${maxAbs}`, padding.left - 3, yToPx(maxAbs) + 3);
  ctx.fillText('0', padding.left - 3, zeroY + 3);
  ctx.fillText(`-${maxAbs}`, padding.left - 3, yToPx(-maxAbs) + 3);
  ctx.textAlign = 'start';
}

/** 绘制实时用时占比曲线（跟弹模式） */
export function renderLiveTimeRatioChart(page: PianoPage): void {
  const canvas = page.liveTimeRatioCanvas;
  const points = page.liveTimeRatioPoints;
  const dpr = window.devicePixelRatio || 1;
  const t = getChartTheme();

  const containerW = page.liveAccuracyPanel.clientWidth - 28;
  const h = 118;
  canvas.style.width = `${containerW}px`;
  canvas.style.height = `${h}px`;
  canvas.width = containerW * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, containerW, h);

  if (points.length === 0) {
    ctx.fillStyle = t.muted;
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('等待弹奏...', containerW / 2, h / 2);
    ctx.textAlign = 'start';
    return;
  }

  const padding = { top: 8, right: 6, bottom: 2, left: 26 };
  const plotW = containerW - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const maxGameSec = points[points.length - 1].gameSec;
  const maxRatio = Math.max(100, ...points.map(p => p.ratio));

  const timeToX = (v: number) => padding.left + (v / maxGameSec) * plotW;
  const ratioToY = (r: number) => padding.top + (1 - Math.min(r, maxRatio) / maxRatio) * plotH;

  // 100% 参考线
  const y100 = ratioToY(100);
  ctx.strokeStyle = t.muted;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(padding.left, y100); ctx.lineTo(padding.left + plotW, y100); ctx.stroke();
  ctx.setLineDash([]);

  // 填充区域
  if (points.length > 1) {
    const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
    const color = maxRatio <= 100 ? t.accent : '#ef4444';
    grad.addColorStop(0, color + '30');
    grad.addColorStop(1, color + '05');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top + plotH);
    for (const p of points) ctx.lineTo(timeToX(p.gameSec), ratioToY(Math.min(p.ratio, maxRatio)));
    ctx.lineTo(timeToX(points[points.length - 1].gameSec), padding.top + plotH);
    ctx.closePath(); ctx.fill();
  }

  // 曲线
  if (points.length > 1) {
    ctx.strokeStyle = maxRatio <= 100 ? t.accent : '#ef4444';
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(timeToX(points[0].gameSec), ratioToY(Math.min(points[0].ratio, maxRatio)));
    for (const p of points) ctx.lineTo(timeToX(p.gameSec), ratioToY(Math.min(p.ratio, maxRatio)));
    ctx.stroke();
  }

  // Y 标签
  ctx.fillStyle = t.muted;
  ctx.font = '7px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(maxRatio)}%`, padding.left - 3, ratioToY(maxRatio) + 3);
  ctx.fillText('100%', padding.left - 3, y100 + 3);
  ctx.textAlign = 'start';
}

/** 更新预览线命中标记 */
export function updateTimingDots(page: PianoPage): void {
  const results = page.scoringEngine.noteResults;

  // 推送新命中到预览线（应用偏移补偿，使位置反映实际判定）
  const wallSec = performance.now() / 1000;
  for (let i = page.lastPushedResultIdx; i < results.length; i++) {
    const nr = results[i];
    if (nr.judgement === 'MISS') continue;
    const adjustedMs = nr.offsetMs - page.scoringEngine.offsetAdjustMs;
    page.fallingNotes.pushTimingMarker(adjustedMs, nr.judgement as 'PERFECT' | 'OK' | 'BAD');
  }
  page.lastPushedResultIdx = results.length;
  page.fallingNotes.tickMarkerTime(wallSec);
}

/** 从计分引擎同步所有实时图表 */
export function updateLiveAccuracyFromEngine(page: PianoPage): void {
  renderLiveTimelineChart(page);
  renderLiveErrorChart(page);

  // 准度曲线需要额外计算数据点
  const results = page.scoringEngine.noteResults;
  if (results.length === 0) return;

  // 按时间升序排列，计算每个位置的累计准度
  const sorted = [...results].sort((a, b) => a.time - b.time);

  const points: Array<{ timeSec: number; accuracy: number }> = [];
  let achieved = 0;

  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    achieved += ACCU_WEIGHT[n.judgement] ?? 0;
    const acc = achieved / (320 * (i + 1));
    points.push({ timeSec: n.time, accuracy: acc });
  }

  page.liveAccuracyPoints = points;
  renderLiveAccuracyChart(page);
}
