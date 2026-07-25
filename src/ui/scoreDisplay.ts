/**
 * 计分 UI 更新
 */
import type { ScoreState } from '../core/scoring';

let lastTotalHits = -1;
let lastWrongKeys = 0;

export function resetScoreUI(): void {
  lastTotalHits = -1;
  lastWrongKeys = 0;
}

export function updateScoreUI(
  state: ScoreState,
  elements: {
    valueEl: HTMLSpanElement;
    accuEl: HTMLSpanElement;
    comboEl: HTMLSpanElement;
    judgeEl: HTMLSpanElement;
    wrongEl: HTMLSpanElement;
    centerJudgeEl?: HTMLDivElement;
  },
): void {
  elements.valueEl.textContent = `${state.score.toLocaleString()}`;
  elements.valueEl.title = `${state.score.toLocaleString()} / ${state.maxScore.toLocaleString()} (含 combo 加成)`;
  elements.accuEl.textContent = `${(state.accuracy * 100).toFixed(2)}%`;

  if (state.combo > 1) {
    elements.comboEl.textContent = `${state.combo} combo`;
  } else {
    elements.comboEl.textContent = '';
  }

  if (state.wrongKeys > 0) {
    elements.wrongEl.textContent = `WRONG ${state.wrongKeys}`;
  } else {
    elements.wrongEl.textContent = '';
  }

  if (state.lastJudgement) {
    const judgeMap: Record<string, string> = {
      PERFECT: 'PERFECT',
      OK: 'OK',
      BAD: 'BAD',
      MISS: 'MISS',
    };
    elements.judgeEl.textContent = judgeMap[state.lastJudgement] ?? '';
    elements.judgeEl.className = 'score-display-judge';
    requestAnimationFrame(() => {
      elements.judgeEl.classList.add(`judge--${state.lastJudgement!.toLowerCase()}`);
    });
  }

  // 居中判定大字 — 每次击键命中/失误/错键时重播
  if (elements.centerJudgeEl) {
    const judgeMap: Record<string, string> = { PERFECT: 'PERFECT', OK: 'OK', BAD: 'BAD', MISS: 'MISS' };
    if (state.lastJudgement && state.totalHits !== lastTotalHits) {
      lastTotalHits = state.totalHits;
      const el = elements.centerJudgeEl;
      el.textContent = judgeMap[state.lastJudgement] ?? '';
      el.className = 'center-judge';
      void el.offsetWidth;
      el.className = `center-judge center-judge--${state.lastJudgement.toLowerCase()}`;
    }
    if (state.wrongKeys !== lastWrongKeys) {
      lastWrongKeys = state.wrongKeys;
      const el = elements.centerJudgeEl;
      el.textContent = 'WRONG';
      el.className = 'center-judge';
      void el.offsetWidth;
      el.className = 'center-judge center-judge--wrong';
    }
  }
}
