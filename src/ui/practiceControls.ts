/**
 * 练习模式控制：循环范围、侧面板记录显示
 */
import type { PracticeLoopRecord } from '../core/types';

export interface PracticeControlElements {
  controlsBar: HTMLDivElement;
  startLabel: HTMLInputElement;
  endLabel: HTMLInputElement;
  loopCounter: HTMLSpanElement;
  loopBest: HTMLSpanElement;
  startDec: HTMLButtonElement;
  startInc: HTMLButtonElement;
  endDec: HTMLButtonElement;
  endInc: HTMLButtonElement;
  sidePanel: HTMLDivElement;
  sideHeader: HTMLDivElement;
  sideScores: HTMLDivElement;
  progressBar: HTMLInputElement;
}

export class PracticeControls {
  measureStart = 0;
  measureEnd = 0;
  totalMeasures = 0;
  loopRound = 0;
  records: PracticeLoopRecord[] = [];
  bestScore = 0;

  elements: PracticeControlElements;

  constructor(elements: PracticeControlElements) {
    this.elements = elements;
  }

  init(totalMeasures: number): void {
    this.totalMeasures = Math.max(1, totalMeasures);
    this.measureStart = 0;
    this.measureEnd = this.totalMeasures - 1;
    this.loopRound = 0;
    this.records = [];
    this.bestScore = 0;
    this.updateUI();
  }

  addRecord(record: PracticeLoopRecord): void {
    this.loopRound++;
    this.records.push(record);
    if (record.score > this.bestScore) this.bestScore = record.score;
    this.updateUI();
  }

  /** 获取最佳一轮记录 */
  getBestRecord(): PracticeLoopRecord | null {
    if (this.records.length === 0) return null;
    let best = this.records[0];
    for (const r of this.records) {
      if (r.score > best.score) best = r;
    }
    return best;
  }

  clampMeasure(v: number): number {
    return Math.max(0, Math.min(this.totalMeasures - 1, v));
  }

  handleStartChange(newVal: number): void {
    this.measureStart = this.clampMeasure(newVal);
    if (this.measureStart > this.measureEnd) this.measureEnd = this.measureStart;
    this.updateUI();
  }

  handleEndChange(newVal: number): void {
    this.measureEnd = this.clampMeasure(newVal);
    if (this.measureEnd < this.measureStart) this.measureStart = this.measureEnd;
    this.updateUI();
  }

  updateUI(): void {
    this.elements.startLabel.value = String(this.measureStart + 1);
    this.elements.startLabel.max = String(this.totalMeasures);
    this.elements.endLabel.value = String(this.measureEnd + 1);
    this.elements.endLabel.max = String(this.totalMeasures);
    this.elements.loopCounter.textContent = `第 ${this.loopRound + 1} 轮`;
    this.elements.loopBest.textContent = this.bestScore > 0 ? `最佳: ${this.bestScore.toLocaleString()}` : '';
    this.renderSidePanel();
    this.updateRangeBar();
  }

  updateRangeBar(): void {
    const bar = this.elements.progressBar;
    if (this.totalMeasures <= 0) {
      bar.style.background = '';
      return;
    }
    const startPct = (this.measureStart / this.totalMeasures) * 100;
    const endPct = ((this.measureEnd + 1) / this.totalMeasures) * 100;
    bar.style.background = `linear-gradient(to right,
      rgba(255,255,255,0.18) 0%,
      rgba(255,255,255,0.18) ${startPct}%,
      rgba(59,108,255,0.5) ${startPct}%,
      rgba(59,108,255,0.5) ${endPct}%,
      rgba(255,255,255,0.18) ${endPct}%,
      rgba(255,255,255,0.18) 100%)`;
  }

  private renderSidePanel(): void {
    if (this.records.length === 0) {
      this.elements.sideScores.innerHTML = '<div class="practice-side-empty">暂无循环记录</div>';
      return;
    }
    let bestIdx = 0;
    let bestScore = 0;
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].score > bestScore) {
        bestScore = this.records[i].score;
        bestIdx = i;
      }
    }
    this.elements.sideScores.innerHTML = this.records.map((r, i) => {
      const isBest = i === bestIdx && this.records.length > 1;
      const cls = isBest ? 'practice-side-score-item practice-side-score-item--best' : 'practice-side-score-item';
      const timePct = r.loopDurationSec > 0 ? (r.elapsedSec / r.loopDurationSec) * 100 : 0;
      const timeColor = timePct <= 100 ? '#22c55e' : timePct <= 130 ? '#fbbf24' : '#ef4444';
      return `<div class="${cls}">
        <div class="practice-side-score-row">
          <span class="practice-side-score-round">#${r.round}</span>
          <span class="practice-side-score-value">${r.score.toLocaleString()}</span>
        </div>
        <div class="practice-side-score-row">
          <span class="practice-side-score-acc">${(r.accuracy * 100).toFixed(1)}%</span>
          <span class="practice-side-score-time" style="color:${timeColor}">⏱ ${timePct.toFixed(0)}%</span>
        </div>
      </div>`;
    }).join('');
  }
}
