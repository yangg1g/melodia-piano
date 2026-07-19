/**
 * 设置系统：持久化、UI 同步、应用
 */
import type { AppSettings, PlayMode } from '../core/types';
import { DIFFICULTY_WINDOWS } from '../core/types';
import type { FallingNotesHandle } from '../rendering/fallingNotes';
import type { ScoringEngine } from '../core/scoring';

const STORAGE_KEY = 'midi-piano-settings';

const DEFAULTS: AppSettings = {
  mode: 'normal',
  fallingSpeed: 3,
  playbackSpeed: 1,
  difficulty: 'normal',
  renderMode: 'image',
  measureWidth: 180,
};

export function loadSettings(): AppSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

/** 填充设置页 UI 控件 */
export function applySettingsToUI(
  s: AppSettings,
  elements: {
    modeRadios: NodeListOf<HTMLInputElement>;
    fallingSpeed: HTMLInputElement;
    fallingSpeedVal: HTMLSpanElement;
    playbackSpeed: HTMLInputElement;
    playbackSpeedVal: HTMLSpanElement;
    measureWidth: HTMLInputElement;
    measureWidthVal: HTMLSpanElement;
    diffRadios: NodeListOf<HTMLInputElement>;
    difficultyInfo: HTMLSpanElement;
    renderRadios: NodeListOf<HTMLInputElement>;
  },
): void {
  const modeRadio = document.querySelector<HTMLInputElement>(`input[name="settings-mode"][value="${s.mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  elements.fallingSpeed.value = String(s.fallingSpeed);
  elements.fallingSpeedVal.textContent = `${s.fallingSpeed.toFixed(1)}s`;
  elements.playbackSpeed.value = String(s.playbackSpeed);
  elements.playbackSpeedVal.textContent = `${s.playbackSpeed.toFixed(1)}×`;
  elements.measureWidth.value = String(s.measureWidth);
  elements.measureWidthVal.textContent = `${s.measureWidth}px`;
  const diffRadio = document.querySelector<HTMLInputElement>(`input[name="settings-difficulty"][value="${s.difficulty}"]`);
  if (diffRadio) diffRadio.checked = true;
  elements.difficultyInfo.textContent = DIFFICULTY_WINDOWS[s.difficulty].label;
  const renderRadio = document.querySelector<HTMLInputElement>(`input[name="settings-render"][value="${s.renderMode}"]`);
  if (renderRadio) renderRadio.checked = true;
}

/** 将设置应用到运行时组件 */
export function applySettings(
  s: AppSettings,
  fallingNotes: FallingNotesHandle,
  scoringEngine: ScoringEngine,
  summaryEl: HTMLElement,
): void {
  fallingNotes.setSpeed(s.fallingSpeed);
  scoringEngine.setWindows(DIFFICULTY_WINDOWS[s.difficulty].windows);
  updateSettingsSummary(s, summaryEl);
}

export function updateSettingsSummary(s: AppSettings, el: HTMLElement): void {
  const modeLabel = s.mode === 'normal' ? '普通模式' : s.mode === 'auto' ? '自动播放' : 'MIDI跟弹';
  const diffLabel = s.difficulty === 'easy' ? '宽松' : s.difficulty === 'normal' ? '普通' : '严格';
  el.textContent = `${modeLabel} · 下落 ${s.fallingSpeed.toFixed(1)}s · 速度 ${s.playbackSpeed.toFixed(1)}× · ${diffLabel}判定`;
}

/** 从设置页 DOM 收集当前设置值 */
export function collectSettingsFromUI(): AppSettings {
  const mode = (document.querySelector<HTMLInputElement>('input[name="settings-mode"]:checked')?.value as PlayMode) ?? 'normal';
  const fallingSpeed = Number((document.querySelector<HTMLInputElement>('#settings-falling-speed'))!.value);
  const playbackSpeed = Number((document.querySelector<HTMLInputElement>('#settings-playback-speed'))!.value);
  const measureWidth = Number((document.querySelector<HTMLInputElement>('#settings-measure-width'))!.value);
  const difficulty = (document.querySelector<HTMLInputElement>('input[name="settings-difficulty"]:checked')?.value as AppSettings['difficulty']) ?? 'normal';
  const renderMode = (document.querySelector<HTMLInputElement>('input[name="settings-render"]:checked')?.value as 'image' | 'original') ?? 'image';
  return { mode, fallingSpeed, playbackSpeed, difficulty, renderMode, measureWidth };
}
