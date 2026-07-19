/**
 * 计分 UI 更新
 */
import type { ScoreState } from '../core/scoring';

export function updateScoreUI(
  state: ScoreState,
  elements: {
    valueEl: HTMLSpanElement;
    accuEl: HTMLSpanElement;
    comboEl: HTMLSpanElement;
    judgeEl: HTMLSpanElement;
    wrongEl: HTMLSpanElement;
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
      MISS: 'MISS',
    };
    elements.judgeEl.textContent = judgeMap[state.lastJudgement] ?? '';
    elements.judgeEl.className = 'score-display-judge';
    requestAnimationFrame(() => {
      elements.judgeEl.classList.add(`judge--${state.lastJudgement!.toLowerCase()}`);
    });
  }
}
