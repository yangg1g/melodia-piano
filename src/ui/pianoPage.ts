/**
 * 钢琴页 —— 核心编排：渲染、播放、编辑、练习
 */
import { Midi } from '@tonejs/midi';
import {
  assignHandForNote,
  buildAtomsForHand,
  flattenNotes,
  getMeasureContext,
  measureCount,
  type FlatNote,
} from '../core/midiScore';
import { playheadXInMeasureOverlay, renderGrandStaffRow, renderGrandStaffRowSVG, type GrandStaffColumn } from '../rendering/renderScore';
import { applyKeyVisuals, createPianoKeyboard } from '../rendering/pianoKeyboard';
import type { FallingNotesHandle } from '../rendering/fallingNotes';
import { playNotes, type PlaybackController } from '../features/playback';
import { startKeyboardPractice } from '../features/keyboardPractice';
import { createStaffEditState, type EditTool } from '../features/staffEditor';
import { ScoringEngine } from '../core/scoring';
import { ensurePiano } from '../audio/salamanderPiano';
import type { PlayMode, PlayHistoryEntry } from '../core/types';
import { loadSettings } from './settings';
import { addHistoryEntry } from './history';
import { showResultScreen, type ResultPageElements } from './resultScreen';
import { countdown } from './countdown';
import { updateProgressBar, resetProgressBar } from './progressBar';
import { updateScoreUI } from './scoreDisplay';
import { MidiSetup } from './midiSetup';
import { PracticeControls } from './practiceControls';

/* ── 常量 ── */
const SCORE_LAYOUT = { measuresPerRow: 2 } as const;

interface ScorePagerState {
  ctx: ReturnType<typeof getMeasureContext>;
  midi: Midi;
  nMeas: number;
  measureWidth: number;
}

/* ── Piano 页状态 ── */
export class PianoPage {
  // 曲谱状态
  currentMidi: Midi | null = null;
  flatNotes: FlatNote[] = [];
  totalDurationSec = 0;
  currentSongFile: string | null = null;
  currentSongName = '';

  // DOM 引用
  pianoPageEl: HTMLDivElement;
  scoreEl: HTMLDivElement;
  scoreScrollEl: HTMLDivElement;
  scorePagerEl: HTMLDivElement;
  keyboardHost: HTMLDivElement;
  keyboardStack: HTMLDivElement;
  keyboardHint: HTMLParagraphElement;
  measureInfoEl: HTMLSpanElement;
  progressBar: HTMLInputElement;
  progressTime: HTMLSpanElement;
  practiceTime: HTMLSpanElement;
  scoreDisplay: HTMLDivElement;

  // 按钮
  btnPlay: HTMLButtonElement;
  btnStop: HTMLButtonElement;
  btnEdit: HTMLButtonElement;
  btnFinger: HTMLButtonElement;
  btnSlur: HTMLButtonElement;
  btnTie: HTMLButtonElement;
  btnStem: HTMLButtonElement;
  btnSaveEdits: HTMLButtonElement;
  editToolbar: HTMLDivElement;

  // 渲染组件
  keyEls: Map<number, HTMLElement>;
  fallingNotes: FallingNotesHandle;
  scoringEngine = new ScoringEngine();

  // 播放状态
  playback: PlaybackController | null = null;
  seeking = false;
  finalWallTimeSec = 0;

  // 乐谱状态
  scorePagerState: ScorePagerState | null = null;
  staffEditState = createStaffEditState();
  editModeActive = false;
  editTool: EditTool = 'select';
  selectedNoteKeys = new Set<string>();
  selDragStart: { x: number; y: number } | null = null;
  selRectEl: HTMLDivElement | null = null;

  // 练习模式
  practice = new PracticeControls({
    controlsBar: document.querySelector<HTMLDivElement>('#practice-controls-bar')!,
    startLabel: document.querySelector<HTMLInputElement>('#practice-start-label')!,
    endLabel: document.querySelector<HTMLInputElement>('#practice-end-label')!,
    loopCounter: document.querySelector<HTMLSpanElement>('#practice-loop-counter')!,
    loopBest: document.querySelector<HTMLSpanElement>('#practice-loop-best')!,
    startDec: document.querySelector<HTMLButtonElement>('#practice-start-dec')!,
    startInc: document.querySelector<HTMLButtonElement>('#practice-start-inc')!,
    endDec: document.querySelector<HTMLButtonElement>('#practice-end-dec')!,
    endInc: document.querySelector<HTMLButtonElement>('#practice-end-inc')!,
    sidePanel: document.querySelector<HTMLDivElement>('#practice-side-panel')!,
    sideHeader: document.querySelector<HTMLDivElement>('#practice-side-header')!,
    sideScores: document.querySelector<HTMLDivElement>('#practice-side-scores')!,
    progressBar: document.querySelector<HTMLInputElement>('#progress-bar')!,
  });
  practiceActive = false;
  practiceRestarting = false;
  practiceLoopNotes: FlatNote[] = [];
  practiceLoopStartFn: (() => void) | null = null;
  practiceLoopDurationSec = 0;
  practiceCurrentWallSec = 0;

  // 计分 UI 元素
  scoreValueEl: HTMLSpanElement;
  scoreAccuEl: HTMLSpanElement;
  scoreComboEl: HTMLSpanElement;
  scoreJudgeEl: HTMLSpanElement;
  scoreWrongEl: HTMLSpanElement;

  // 结果页
  resultElements: ResultPageElements;

  // MIDI 设备
  midiSetup: MidiSetup;

  // 回调
  onGoBack?: () => void;

  constructor(elements: {
    pianoPageEl: HTMLDivElement;
    scoreEl: HTMLDivElement;
    scoreScrollEl: HTMLDivElement;
    scorePagerEl: HTMLDivElement;
    keyboardHost: HTMLDivElement;
    keyboardStack: HTMLDivElement;
    keyboardHint: HTMLParagraphElement;
    measureInfoEl: HTMLSpanElement;
    progressBar: HTMLInputElement;
    progressTime: HTMLSpanElement;
    practiceTime: HTMLSpanElement;
    scoreDisplay: HTMLDivElement;
    btnPlay: HTMLButtonElement;
    btnStop: HTMLButtonElement;
    btnEdit: HTMLButtonElement;
    btnFinger: HTMLButtonElement;
    btnSlur: HTMLButtonElement;
    btnTie: HTMLButtonElement;
    btnStem: HTMLButtonElement;
    btnSaveEdits: HTMLButtonElement;
    editToolbar: HTMLDivElement;
    scoreValueEl: HTMLSpanElement;
    scoreAccuEl: HTMLSpanElement;
    scoreComboEl: HTMLSpanElement;
    scoreJudgeEl: HTMLSpanElement;
    scoreWrongEl: HTMLSpanElement;
    resultElements: ResultPageElements;
    midiSetup: MidiSetup;
    fallingNotes: FallingNotesHandle;
  }) {
    this.pianoPageEl = elements.pianoPageEl;
    this.scoreEl = elements.scoreEl;
    this.scoreScrollEl = elements.scoreScrollEl;
    this.scorePagerEl = elements.scorePagerEl;
    this.keyboardHost = elements.keyboardHost;
    this.keyboardStack = elements.keyboardStack;
    this.keyboardHint = elements.keyboardHint;
    this.measureInfoEl = elements.measureInfoEl;
    this.progressBar = elements.progressBar;
    this.progressTime = elements.progressTime;
    this.practiceTime = elements.practiceTime;
    this.scoreDisplay = elements.scoreDisplay;
    this.btnPlay = elements.btnPlay;
    this.btnStop = elements.btnStop;
    this.btnEdit = elements.btnEdit;
    this.btnFinger = elements.btnFinger;
    this.btnSlur = elements.btnSlur;
    this.btnTie = elements.btnTie;
    this.btnStem = elements.btnStem;
    this.btnSaveEdits = elements.btnSaveEdits;
    this.editToolbar = elements.editToolbar;
    this.scoreValueEl = elements.scoreValueEl;
    this.scoreAccuEl = elements.scoreAccuEl;
    this.scoreComboEl = elements.scoreComboEl;
    this.scoreJudgeEl = elements.scoreJudgeEl;
    this.scoreWrongEl = elements.scoreWrongEl;
    this.resultElements = elements.resultElements;
    this.midiSetup = elements.midiSetup;
    this.fallingNotes = elements.fallingNotes;
    this.keyEls = createPianoKeyboard(this.keyboardHost);
    this.initEvents();
  }

  /* ── 事件绑定 ── */
  private initEvents(): void {
    this.btnPlay.addEventListener('click', () => this.startPlayFrom(0));
    this.btnStop.addEventListener('click', () => this.stopPlayback());
    this.btnEdit.addEventListener('click', () => this.toggleEditMode());
    this.btnFinger.addEventListener('click', () => this.setEditTool('select', '指法编辑：点击/框选音符后按 1-5 设指法，Shift+单击多选'));
    this.btnSlur.addEventListener('click', () => { this.setEditTool('slur', '连音编辑：依次单击两个音符创建连线'); this.selectedNoteKeys.clear(); this.renderAll(); });
    this.btnTie.addEventListener('click', () => { this.setEditTool('tie', '连尾编辑：依次单击两个相邻音符将其符杆/符尾相连'); this.selectedNoteKeys.clear(); this.renderAll(); });
    this.btnStem.addEventListener('click', () => this.handleStemToggle());
    this.btnSaveEdits.addEventListener('click', () => this.saveEdits());

    // 进度条
    let wasPlayingBeforeSeek = false;
    this.progressBar.addEventListener('input', () => {
      if (this.getPlayMode() === 'keyboard' || this.practiceActive) return;
      this.seeking = true;
      if (this.playback && !wasPlayingBeforeSeek) {
        wasPlayingBeforeSeek = true;
        this.playback.stop();
        this.playback = null;
        this.btnPlay.disabled = false;
        this.btnStop.disabled = true;
      }
      if (!this.currentMidi || this.flatNotes.length === 0) return;
      const pct = Number(this.progressBar.value) / 1000;
      updateProgressBar(this.progressBar, this.progressTime, pct * this.totalDurationSec, this.totalDurationSec, false);
    });

    this.progressBar.addEventListener('change', () => {
      if (this.getPlayMode() === 'keyboard' || this.practiceActive) return;
      this.seeking = false;
      if (!this.currentMidi || this.flatNotes.length === 0) return;
      const pct = Number(this.progressBar.value) / 1000;
      const timeSec = pct * this.totalDurationSec;
      updateProgressBar(this.progressBar, this.progressTime, timeSec, this.totalDurationSec, false);
      if (wasPlayingBeforeSeek) {
        wasPlayingBeforeSeek = false;
        this.startPlayFrom(timeSec);
      }
    });

    // 练习范围控制
    this.practice.elements.startDec.addEventListener('click', () => this.handlePracticeStartChange(this.practice.measureStart - 1));
    this.practice.elements.startInc.addEventListener('click', () => this.handlePracticeStartChange(this.practice.measureStart + 1));
    this.practice.elements.endDec.addEventListener('click', () => this.handlePracticeEndChange(this.practice.measureEnd - 1));
    this.practice.elements.endInc.addEventListener('click', () => this.handlePracticeEndChange(this.practice.measureEnd + 1));
    this.practice.elements.startLabel.addEventListener('change', () => {
      const v = parseInt(this.practice.elements.startLabel.value, 10);
      if (!isNaN(v) && v >= 1) this.handlePracticeStartChange(v - 1);
      else this.practice.updateUI();
    });
    this.practice.elements.endLabel.addEventListener('change', () => {
      const v = parseInt(this.practice.elements.endLabel.value, 10);
      if (!isNaN(v) && v >= 1) this.handlePracticeEndChange(v - 1);
      else this.practice.updateUI();
    });

    // 编辑模式键盘事件
    document.addEventListener('keydown', (e) => this.handleEditKeydown(e));

    // 音符选择 + 框选
    this.scoreEl.addEventListener('mousedown', (e) => this.handleScoreMouseDown(e));
    this.scoreScrollEl.addEventListener('mousemove', (e) => this.handleScoreMouseMove(e));
    document.addEventListener('mouseup', () => this.handleScoreMouseUp());
  }

  /* ── 模式 ── */
  getPlayMode(): PlayMode {
    return loadSettings().mode;
  }

  getRenderMode(): 'image' | 'original' {
    return loadSettings().renderMode;
  }

  updateKeyboardHint(): void {
    const mode = this.getPlayMode();
    if (mode === 'auto') {
      this.keyboardHint.textContent = '根据 MIDI 生成的五线谱（高音 / 低音谱表）。琴键上方为下落式音符（绿左 / 蓝右；白键稍亮、黑键更深）。键盘高亮同上。';
    } else if (mode === 'keyboard') {
      this.keyboardHint.textContent = 'MIDI 跟弹：绿色 / 蓝色描边为当前应弹的左 / 右手音；弹对后条缩短并发声前进；紫红色外圈为正在按下的键，错音不出声。';
    } else {
      this.keyboardHint.textContent = '普通模式：自动播放曲目，可同时使用 MIDI 键盘弹奏，实时判定计分。';
    }
  }

  syncModeUi(): void {
    this.scoreDisplay.hidden = this.getPlayMode() === 'auto';
    if (!this.playback && !this.practiceActive) {
      this.practice.elements.sidePanel.hidden = this.getPlayMode() === 'auto';
    }
    this.updateKeyboardHint();
    this.btnEdit.hidden = this.pianoPageEl.hidden || this.getRenderMode() !== 'original';
    const isKeyboard = this.getPlayMode() === 'keyboard';
    this.progressBar.style.pointerEvents = isKeyboard ? 'none' : '';
    this.progressBar.style.opacity = isKeyboard ? '0.55' : '';
  }

  /* ── 乐谱渲染 ── */

  renderAll(midi?: Midi): void {
    const m = midi ?? this.currentMidi;
    if (!m) return;
    this.currentMidi = m;
    this.flatNotes = flattenNotes(m);
    this.scoreEl.innerHTML = '';

    const settings = loadSettings();
    const mode = settings.renderMode;
    const measureWidth = settings.measureWidth;

    if (mode === 'image') {
      this.scoreEl.style.cssText = 'position:relative;will-change:transform';
      this.scoreScrollEl.style.cssText = 'overflow:hidden;position:relative';
      this.renderStaffImage(this.scoreEl, m, measureWidth);
      this.addJudgmentLine();
      this.scoreEl.style.transform = `translateX(${this.getJudgeX()}px)`;
    } else {
      this.scoreEl.style.cssText = '';
      this.scoreScrollEl.style.cssText = 'overflow:auto;position:relative';
      this.scoreScrollEl.querySelector('.judgment-line')?.remove();
      this.renderStaffOriginal(this.scoreEl, m, measureWidth);
      this.hideScorePlayhead();
    }

    const range = noteRange(this.flatNotes);
    this.keyEls = createPianoKeyboard(this.keyboardHost, range.min, range.max);
    this.fallingNotes.setRange(range.min, range.max);
    this.fallingNotes.setSource(this.flatNotes, m);
    this.fallingNotes.clear();

    if (this.scorePagerState) this.updateMeasureInfo(0, this.scorePagerState.nMeas);

    this.totalDurationSec = m.duration;
    resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);
  }

  /* ── 设置/进入/离开 ── */

  async setupPianoPage(midi: Midi): Promise<void> {
    this.editModeActive = false;
    this.selectedNoteKeys.clear();
    this.staffEditState = createStaffEditState();

    if (this.currentSongFile) {
      const saved = localStorage.getItem(`midi-edits-${this.currentSongFile}`);
      if (saved) {
        try {
          const raw = JSON.parse(saved);
          this.staffEditState.fingerNumbers = new Map(raw.fingerNumbers ?? []);
          this.staffEditState.slurs = raw.slurs ?? [];
          this.staffEditState.ties = raw.ties ?? [];
          this.staffEditState.stemDirections = new Map((raw.stemDirections ?? []).map(
            ([k, v]: [string, number]) => [k, v as 1 | -1],
          ));
        } catch { /* ignore */ }
      }
    }
    this.renderAll(midi);
    this.syncModeUi();
  }

  async enterAndPlay(midi: Midi): Promise<void> {
    await this.setupPianoPage(midi);
    this.practiceActive = false;
    this.practice.elements.sidePanel.hidden = false;
    this.practice.elements.sideHeader.hidden = true;
    this.practice.elements.sideScores.hidden = true;
    await countdown(3, this.pianoPageEl);
    await this.startPlayFrom(0);
  }

  async enterPractice(midi: Midi): Promise<void> {
    await this.setupPianoPage(midi);
    this.practiceActive = true;
    this.practice.elements.controlsBar.hidden = false;
    this.practice.elements.sidePanel.hidden = false;
    this.practice.elements.sideHeader.hidden = false;
    this.practice.elements.sideScores.hidden = false;
    this.practice.elements.sideScores.innerHTML = '';
    this.practice.init(measureCount(midi, getMeasureContext(midi)));
    this.practice.updateUI();
    this.btnPlay.disabled = true;
    this.btnStop.disabled = false;
    await this.startPlayFrom(0);
  }

  stopPlayback(): void {
    if (this.practiceActive && this.practice.records.length > 0) {
      const best = this.practice.getBestRecord();
      if (best) {
        const curSettings = loadSettings();
        let maxComboRun = 0;
        let curRun = 0;
        for (const nr of best.noteResults) {
          if (nr.judgement !== 'MISS') { curRun++; if (curRun > maxComboRun) maxComboRun = curRun; }
          else curRun = 0;
        }
        const entry: PlayHistoryEntry = {
          songFile: this.currentSongFile ?? '',
          songName: this.currentSongName,
          score: best.score,
          accuracy: best.accuracy,
          maxCombo: maxComboRun,
          mode: 'practice',
          date: new Date().toISOString(),
          settings: { fallingSpeed: curSettings.fallingSpeed, playbackSpeed: curSettings.playbackSpeed, difficulty: curSettings.difficulty },
          noteResults: best.noteResults,
          wrongKeyRecords: best.wrongKeyRecords,
          wallTimeSec: this.finalWallTimeSec || undefined,
          originalDurationSec: undefined,
        };
        if (this.currentSongFile) {
          try { addHistoryEntry(entry); } catch { /* ignore */ }
        }
        this.pianoPageEl.hidden = true;
        showResultScreen(entry, this.scoringEngine.getMaxTheoreticalScore(), this.resultElements);
      }
    }

    this.playback?.stop();
    this.playback = null;
    this.hideScorePlayhead();
    if (this.scorePagerState) this.updateMeasureInfo(0, this.scorePagerState.nMeas);
    this.fallingNotes.clear();
    applyKeyVisuals(this.keyEls, {});
    this.btnPlay.disabled = false;
    this.btnStop.disabled = true;
    resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);
    this.practiceTime.hidden = true;
    this.finalWallTimeSec = 0;
    this.practiceActive = false;
    this.progressBar.style.background = '';
    this.practice.elements.sideHeader.hidden = false;
    this.practice.elements.sideScores.hidden = false;
    this.practice.elements.sideScores.innerHTML = '';
  }

  /* ── 播放逻辑 ── */

  async startPlayFrom(offsetSec: number): Promise<void> {
    if (!this.currentMidi || this.flatNotes.length === 0) return;
    const wasPracticeActive = this.practiceActive;
    this.stopPlayback();
    this.practiceActive = wasPracticeActive;

    this.btnPlay.disabled = true;
    this.btnStop.disabled = false;

    const mode = this.getPlayMode();
    const settings = loadSettings();

    const onPlaybackEnded = () => {
      this.hideScorePlayhead();
      this.fallingNotes.clear();
      this.btnPlay.disabled = false;
      this.btnStop.disabled = true;
      this.playback = null;
      resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);

      if (this.getPlayMode() !== 'auto') {
        // 构建入场并显示结算
        const curSettings = loadSettings();
        const state = this.scoringEngine.getState();
        const entry: PlayHistoryEntry = {
          songFile: this.currentSongFile ?? '',
          songName: this.currentSongName,
          score: this.scoringEngine.getTotalScore(),
          accuracy: state.accuracy,
          maxCombo: state.maxCombo,
          mode: curSettings.mode,
          date: new Date().toISOString(),
          settings: { fallingSpeed: curSettings.fallingSpeed, playbackSpeed: curSettings.playbackSpeed, difficulty: curSettings.difficulty },
          noteResults: this.scoringEngine.noteResults,
          wrongKeyRecords: this.scoringEngine.wrongKeyRecords,
          wallTimeSec: this.finalWallTimeSec || undefined,
          originalDurationSec: this.totalDurationSec || undefined,
        };
        if (this.currentSongFile) {
          try { addHistoryEntry(entry); } catch { /* 忽略存储错误 */ }
        }
        // 先隐藏钢琴页，再显示结算画面
        this.pianoPageEl.hidden = true;
        showResultScreen(entry, this.scoringEngine.getMaxTheoreticalScore(), this.resultElements);
      }
    };

    // 音频初始化重试
    {
      let retries = 3;
      let lastErr: unknown;
      while (retries > 0) {
        try {
          await ensurePiano();
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          retries--;
          if (retries > 0) {
            console.warn(`音频引擎初始化失败，剩余重试次数: ${retries}`, err);
            await new Promise(r => setTimeout(r, 500));
          }
        }
      }
      if (lastErr) {
        console.error('[startPlayFrom] 重试耗尽，初始化失败:', lastErr);
        alert('音频引擎初始化失败，请刷新页面重试。');
        onPlaybackEnded();
        return;
      }
    }

    /* ── 自动播放模式 ── */
    if (mode === 'auto') {
      const sorted = [...this.flatNotes].sort((a, b) => {
        const ha = assignHandForNote(a, this.currentMidi!);
        const hb = assignHandForNote(b, this.currentMidi!);
        if (ha !== hb) return ha === 'treble' ? -1 : 1;
        return a.time - b.time || a.midi - b.midi;
      });
      this.scoreDisplay.hidden = true;
      this.playback = playNotes(
        sorted,
        this.currentMidi!,
        this.currentMidi!.duration,
        (active) => applyKeyVisuals(this.keyEls, { active }),
        onPlaybackEnded,
        (t) => {
          this.updateScorePlayhead(t);
          this.fallingNotes.update(t);
          updateProgressBar(this.progressBar, this.progressTime, t, this.totalDurationSec, this.seeking);
        },
        offsetSec,
        settings.playbackSpeed,
      );
      return;
    }

    /* ── 需要 MIDI 输入的模式 ── */
    const access = await this.midiSetup.ensureAccess();
    if (!access) {
      alert('当前浏览器不支持 Web MIDI，或用户拒绝了权限。请使用 Chrome / Edge 等浏览器。');
      onPlaybackEnded();
      return;
    }
    this.midiSetup.refillSelects();
    const input = this.midiSetup.getSelectedInput();
    if (!input) {
      alert('未检测到 MIDI 输入设备。请先连接键盘，或点击「刷新设备」后再试。');
      onPlaybackEnded();
      return;
    }
    try { await input.open(); } catch {
      alert('无法打开所选 MIDI 输入端口。');
      onPlaybackEnded();
      return;
    }

    /* ── 练习模式 ── */
    if (this.practiceActive) {
      this.practice.loopRound = 0;
      this.practice.records = [];
      this.practice.bestScore = 0;
      this.practice.updateUI();

      const midi = this.currentMidi!;
      const ctx = getMeasureContext(midi);
      const ticksPerMeasure = ctx.ticksPerMeasure;
      const startTick = this.practice.measureStart * ticksPerMeasure;
      const endTick = (this.practice.measureEnd + 1) * ticksPerMeasure;
      const startTimeSec = midi.header.ticksToSeconds(startTick);
      const endTimeSec = midi.header.ticksToSeconds(endTick);
      this.practiceLoopDurationSec = endTimeSec - startTimeSec;

      this.practiceLoopNotes = this.flatNotes
        .filter(n => n.ticks >= startTick && n.ticks < endTick)
        .map(n => ({ ...n, time: n.time - startTimeSec, ticks: n.ticks - startTick }));

      this.scoreDisplay.hidden = false;

      const startLoop = () => {
        if (!this.practiceActive) return;

        const holdCount = this.practiceLoopNotes.filter(n => Math.max(0, n.duration) >= 0.05).length;
        this.scoringEngine.reset({ totalNotes: this.practiceLoopNotes.length, holdNoteCount: holdCount });
        updateScoreUI(this.scoringEngine.getState(), this.scoreElements());
        this.practiceCurrentWallSec = 0;

        const onLoopEnded = () => {
          this.hideScorePlayhead();
          this.fallingNotes.clear();
          this.playback = null;
          resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);
          this.updateMeasureInfo(0, this.practice.measureEnd - this.practice.measureStart + 1);

          if (!this.practiceActive) {
            this.btnPlay.disabled = false;
            this.btnStop.disabled = true;
            return;
          }
          if (this.practiceRestarting) return;

          const snap = this.scoringEngine.snapshot();
          this.practice.addRecord({
            round: this.practice.loopRound + 1,
            score: snap.score,
            maxScore: snap.maxScore,
            accuracy: snap.accuracy,
            elapsedSec: this.practiceCurrentWallSec,
            loopDurationSec: this.practiceLoopDurationSec,
            counts: snap.counts,
            noteResults: snap.noteResults,
            wrongKeyRecords: snap.wrongKeyRecords,
          });

          setTimeout(() => {
            if (!this.practiceActive) return;
            startLoop();
          }, 500);
        };

        this.playback = startKeyboardPractice(
          this.practiceLoopNotes,
          midi,
          this.keyEls,
          input,
          onLoopEnded,
          (t) => {
            this.updateScorePlayhead(t);
            updateProgressBar(this.progressBar, this.progressTime, t, this.practiceLoopDurationSec, this.seeking);
            const currentTick = startTick + midi.header.secondsToTicks(t);
            const currentMeasure = Math.floor(currentTick / ticksPerMeasure);
            const loopMeasure = Math.max(0, Math.min(currentMeasure - this.practice.measureStart, this.practice.measureEnd - this.practice.measureStart));
            this.updateMeasureInfo(loopMeasure, this.practice.measureEnd - this.practice.measureStart + 1);
          },
          (s) => this.fallingNotes.updateKeyboardPractice(s),
          this.scoringEngine,
          (state) => updateScoreUI(state, this.scoreElements()),
          false,
          settings.playbackSpeed,
          (wallSec) => { this.practiceCurrentWallSec = wallSec; },
        );
      };

      this.practiceLoopStartFn = startLoop;
      startLoop();
      return;
    }

    /* ── 普通模式 ── */
    if (mode === 'normal') {
      this.scoreDisplay.hidden = false;
      const holdCount = this.flatNotes.filter(n => Math.max(0, n.duration) >= 0.05).length;
      this.scoringEngine.reset({ totalNotes: this.flatNotes.length, holdNoteCount: holdCount });
      updateScoreUI(this.scoringEngine.getState(), this.scoreElements());

      this.playback = startKeyboardPractice(
        this.flatNotes,
        this.currentMidi!,
        this.keyEls,
        input,
        onPlaybackEnded,
        (t) => {
          this.updateScorePlayhead(t);
          updateProgressBar(this.progressBar, this.progressTime, t, this.totalDurationSec, this.seeking);
        },
        (s) => this.fallingNotes.updateKeyboardPractice(s),
        this.scoringEngine,
        (state) => updateScoreUI(state, this.scoreElements()),
        true,
        settings.playbackSpeed,
      );
      return;
    }

    /* ── MIDI 跟弹模式 ── */
    if (mode === 'keyboard') {
      this.scoreDisplay.hidden = false;
      const holdCount = this.flatNotes.filter(n => Math.max(0, n.duration) >= 0.05).length;
      this.scoringEngine.reset({ totalNotes: this.flatNotes.length, holdNoteCount: holdCount });
      updateScoreUI(this.scoringEngine.getState(), this.scoreElements());

      this.practiceTime.hidden = false;
      this.finalWallTimeSec = 0;
      let lastGameTimeSec = 0;

      this.playback = startKeyboardPractice(
        this.flatNotes,
        this.currentMidi!,
        this.keyEls,
        input,
        onPlaybackEnded,
        (t) => {
          this.updateScorePlayhead(t);
          updateProgressBar(this.progressBar, this.progressTime, t, this.totalDurationSec, this.seeking);
          lastGameTimeSec = t;
        },
        (s) => this.fallingNotes.updateKeyboardPractice(s),
        this.scoringEngine,
        (state) => updateScoreUI(state, this.scoreElements()),
        false,
        settings.playbackSpeed,
        (wallSec) => {
          this.finalWallTimeSec = wallSec;
          const refTimeSec = lastGameTimeSec > 0 ? lastGameTimeSec : this.totalDurationSec;
          const pct = refTimeSec > 0 ? Math.max(0, (wallSec / refTimeSec) * 100) : 0;
          this.practiceTime.textContent = `用时 ${formatTime(wallSec)} · ${pct.toFixed(1)}%`;
        },
      );
      return;
    }
  }

  /* ── 乐谱播放头 ── */

  private updateScorePlayhead(timeSec: number): void {
    if (this.getRenderMode() === 'image') {
      this.updatePlayheadImage(timeSec);
    } else {
      this.updatePlayheadOriginal(timeSec);
    }
  }

  hideScorePlayhead(): void {
    if (this.getRenderMode() === 'image') {
      this.resetStaffScroll();
    } else {
      for (const ph of this.scoreEl.querySelectorAll<HTMLElement>('.playhead')) {
        ph.classList.remove('is-visible');
      }
    }
  }

  /* ── 编辑模式 ── */

  private toggleEditMode(): void {
    this.editModeActive = !this.editModeActive;
    this.syncEditModeUI();
    if (this.editModeActive) {
      this.stopPlayback();
      this.selectedNoteKeys.clear();
      this.renderAll();
    } else {
      this.selectedNoteKeys.clear();
    }
  }

  private setEditTool(tool: EditTool, hint: string): void {
    this.editTool = tool;
    this.syncEditModeUI();
    this.keyboardHint.textContent = hint;
  }

  private handleStemToggle(): void {
    if (this.selectedNoteKeys.size === 0) return;
    let hasDown = false;
    for (const nk of this.selectedNoteKeys) {
      if (this.staffEditState.stemDirections.get(nk) === -1) { hasDown = true; break; }
    }
    const dir: 1 | -1 = hasDown ? 1 : -1;
    for (const nk of this.selectedNoteKeys) {
      this.staffEditState.stemDirections.set(nk, dir);
    }
    this.renderAll();
  }

  private saveEdits(): void {
    if (!this.currentSongFile) { alert('未加载歌曲'); return; }
    const key = `midi-edits-${this.currentSongFile}`;
    const json = JSON.stringify({
      fingerNumbers: [...this.staffEditState.fingerNumbers.entries()],
      slurs: this.staffEditState.slurs,
      ties: this.staffEditState.ties,
      stemDirections: [...this.staffEditState.stemDirections.entries()],
    });
    localStorage.setItem(key, json);
    this.btnSaveEdits.textContent = '✓ 已保存';
    setTimeout(() => { this.btnSaveEdits.textContent = '保存'; }, 2000);
  }

  private syncEditModeUI(): void {
    const show = this.editModeActive;
    this.btnEdit.textContent = show ? '✓ 编辑' : '编辑';
    this.btnEdit.classList.toggle('primary', show);
    this.btnEdit.classList.toggle('secondary', !show);
    this.editToolbar.hidden = !show;
    this.btnFinger.classList.toggle('primary', this.editTool === 'select');
    this.btnFinger.classList.toggle('secondary', this.editTool !== 'select');
    this.btnSlur.classList.toggle('primary', this.editTool === 'slur');
    this.btnSlur.classList.toggle('secondary', this.editTool !== 'slur');
    this.btnTie.classList.toggle('primary', this.editTool === 'tie');
    this.btnTie.classList.toggle('secondary', this.editTool !== 'tie');
    if (!show) {
      this.keyboardHint.textContent = this.keyboardHint.textContent?.replace(/编辑.*?。/, '') ?? '';
    }
  }

  private handleEditKeydown(e: KeyboardEvent): void {
    if (!this.editModeActive || this.selectedNoteKeys.size === 0 || this.getPlayMode() === 'auto') return;
    if (e.repeat) return;
    if (e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      for (const nk of this.selectedNoteKeys) this.staffEditState.fingerNumbers.set(nk, Number(e.key));
      this.renderAll();
    } else if (e.key === '0' || e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      for (const nk of this.selectedNoteKeys) {
        this.staffEditState.fingerNumbers.delete(nk);
        this.staffEditState.slurs = this.staffEditState.slurs.filter(s => s.from !== nk && s.to !== nk);
        this.staffEditState.ties = this.staffEditState.ties.filter(t => t.from !== nk && t.to !== nk);
        this.staffEditState.stemDirections.delete(nk);
      }
      this.selectedNoteKeys.clear();
      this.renderAll();
    }
  }

  private handleScoreMouseDown(e: MouseEvent): void {
    if (!this.editModeActive || this.getRenderMode() !== 'original') return;
    const hit = (e.target as HTMLElement).closest<HTMLElement>('.note-hitarea');
    if (hit && hit.dataset.noteKey) {
      const nk = hit.dataset.noteKey;
      if (e.shiftKey) {
        if (this.selectedNoteKeys.has(nk)) this.selectedNoteKeys.delete(nk);
        else this.selectedNoteKeys.add(nk);
      } else {
        this.selectedNoteKeys.clear();
        this.selectedNoteKeys.add(nk);
      }
      if (this.selectedNoteKeys.size === 2) {
        const [a, b] = [...this.selectedNoteKeys];
        if (this.editTool === 'slur') this.staffEditState.slurs.push({ from: a, to: b });
        else if (this.editTool === 'tie') this.staffEditState.ties.push({ from: a, to: b });
        this.selectedNoteKeys.clear();
      }
      this.renderAll();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    this.selectedNoteKeys.clear();
    this.renderAll();
    const rect = this.scoreScrollEl.getBoundingClientRect();
    this.selDragStart = { x: e.clientX - rect.left + this.scoreScrollEl.scrollLeft, y: e.clientY - rect.top + this.scoreScrollEl.scrollTop };
    const sel = this.ensureSelRect();
    sel.style.display = 'block';
    sel.style.left = `${this.selDragStart.x}px`;
    sel.style.top = `${this.selDragStart.y}px`;
    sel.style.width = '0';
    sel.style.height = '0';
  }

  private handleScoreMouseMove(e: MouseEvent): void {
    if (!this.selDragStart || !this.selRectEl) return;
    e.preventDefault();
    const rect = this.scoreScrollEl.getBoundingClientRect();
    const curX = e.clientX - rect.left + this.scoreScrollEl.scrollLeft;
    const curY = e.clientY - rect.top + this.scoreScrollEl.scrollTop;
    const l = Math.min(this.selDragStart.x, curX);
    const t = Math.min(this.selDragStart.y, curY);
    const w = Math.abs(curX - this.selDragStart.x);
    const h = Math.abs(curY - this.selDragStart.y);
    this.selRectEl.style.left = `${l}px`;
    this.selRectEl.style.top = `${t}px`;
    this.selRectEl.style.width = `${w}px`;
    this.selRectEl.style.height = `${h}px`;
  }

  private handleScoreMouseUp(): void {
    if (!this.selDragStart || !this.selRectEl) return;
    if (this.selRectEl.style.display === 'none') { this.selDragStart = null; return; }
    const rect = this.selRectEl.getBoundingClientRect();
    const hits = this.scoreScrollEl.querySelectorAll<HTMLElement>('.note-hitarea');
    this.selectedNoteKeys.clear();
    for (const h of hits) {
      const hRect = h.getBoundingClientRect();
      if (hRect.right > rect.left && hRect.left < rect.right &&
          hRect.bottom > rect.top && hRect.top < rect.bottom) {
        if (h.dataset.noteKey) this.selectedNoteKeys.add(h.dataset.noteKey);
      }
    }
    this.removeSelRect();
    this.selDragStart = null;
    this.renderAll();
  }

  private ensureSelRect(): HTMLDivElement {
    if (!this.selRectEl) {
      this.selRectEl = document.createElement('div');
      this.selRectEl.className = 'sel-rect';
      this.scoreScrollEl.appendChild(this.selRectEl);
    }
    return this.selRectEl;
  }

  private removeSelRect(): void {
    if (this.selRectEl) { this.selRectEl.style.display = 'none'; this.selRectEl.style.width = '0'; this.selRectEl.style.height = '0'; }
  }

  private handlePracticeStartChange(newVal: number): void {
    this.practice.handleStartChange(newVal);
    this.restartPracticeLoop();
  }

  private handlePracticeEndChange(newVal: number): void {
    this.practice.handleEndChange(newVal);
    this.restartPracticeLoop();
  }

  restartPracticeLoop(): void {
    if (!this.practiceActive || !this.currentMidi || !this.practiceLoopStartFn) return;
    this.practiceRestarting = true;
    this.playback?.stop();
    this.playback = null;
    this.fallingNotes.clear();
    this.hideScorePlayhead();
    resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);
    this.updateMeasureInfo(0, this.practice.measureEnd - this.practice.measureStart + 1);

    const midi = this.currentMidi;
    const ctx = getMeasureContext(midi);
    const ticksPerMeasure = ctx.ticksPerMeasure;
    const startTick = this.practice.measureStart * ticksPerMeasure;
    const endTick = (this.practice.measureEnd + 1) * ticksPerMeasure;
    const startTimeSec = midi.header.ticksToSeconds(startTick);
    const endTimeSec = midi.header.ticksToSeconds(endTick);
    this.practiceLoopDurationSec = endTimeSec - startTimeSec;

    this.practiceLoopNotes = this.flatNotes
      .filter(n => n.ticks >= startTick && n.ticks < endTick)
      .map(n => ({ ...n, time: n.time - startTimeSec, ticks: n.ticks - startTick }));

    this.practiceLoopStartFn();
    this.practiceRestarting = false;
  }

  /* ── Score 渲染辅助 ── */

  private scoreElements() {
    return { valueEl: this.scoreValueEl, accuEl: this.scoreAccuEl, comboEl: this.scoreComboEl, judgeEl: this.scoreJudgeEl, wrongEl: this.scoreWrongEl };
  }

  private renderStaffImage(stripEl: HTMLElement, midi: Midi, measureWidth: number): void {
    const ctx = getMeasureContext(midi);
    const nMeas = measureCount(midi, ctx);
    const columns: GrandStaffColumn[] = [];
    for (let i = 0; i < nMeas; i++) {
      columns.push({
        measureIndex: i, trebleAtoms: buildAtomsForHand(this.flatNotes, midi, 'treble', ctx, i),
        bassAtoms: buildAtomsForHand(this.flatNotes, midi, 'bass', ctx, i), showStaffHeader: i === 0,
      });
    }
    const { height: stripHeight } = renderGrandStaffRow(
      stripEl, columns, ctx, measureWidth, true,
      this.staffEditState, this.editModeActive ? this.selectedNoteKeys : undefined,
    );
    this.scorePagerState = { ctx, midi, nMeas, measureWidth };
    stripEl.style.minHeight = `${stripHeight}px`;
  }

  private renderStaffOriginal(parent: HTMLElement, midi: Midi, measureWidth: number): void {
    const ctx = getMeasureContext(midi);
    const nMeas = measureCount(midi, ctx);
    const measuresPerRow = SCORE_LAYOUT.measuresPerRow;
    this.scorePagerState = { ctx, midi, nMeas, measureWidth };

    parent.style.cssText = '';
    this.scoreScrollEl.style.cssText = 'overflow:auto;position:relative';

    for (let start = 0; start < nMeas; start += measuresPerRow) {
      const rowWrap = document.createElement('div');
      rowWrap.className = 'score-measure-row';
      parent.appendChild(rowWrap);
      const end = Math.min(nMeas, start + measuresPerRow);
      const columns: GrandStaffColumn[] = [];
      for (let i = start; i < end; i++) {
        columns.push({
          measureIndex: i, trebleAtoms: buildAtomsForHand(this.flatNotes, midi, 'treble', ctx, i),
          bassAtoms: buildAtomsForHand(this.flatNotes, midi, 'bass', ctx, i), showStaffHeader: i === start,
        });
      }
      renderGrandStaffRowSVG(rowWrap, columns, ctx, measureWidth, this.staffEditState,
        this.editModeActive ? this.selectedNoteKeys : undefined);
    }
  }

  private addJudgmentLine(): void {
    const old = this.scoreScrollEl.querySelector('.judgment-line');
    if (old) old.remove();
    const line = document.createElement('div');
    line.className = 'judgment-line';
    line.setAttribute('aria-hidden', 'true');
    this.scoreScrollEl.appendChild(line);
  }

  private resetStaffScroll(): void {
    this.scoreEl.style.transform = `translateX(${this.getJudgeX()}px)`;
  }

  private getJudgeX(): number {
    return Math.max(80, Math.floor(this.scoreScrollEl.clientWidth * 0.25));
  }

  private scrollStaffToProgress(progress01: number): void {
    const st = this.scorePagerState;
    if (!st) return;
    this.scoreEl.style.transform = `translateX(${this.getJudgeX() - progress01 * st.nMeas * st.measureWidth}px)`;
  }

  private updateMeasureInfo(current: number, total: number): void {
    if (total <= 0) { this.measureInfoEl.textContent = ''; return; }
    this.measureInfoEl.textContent = `第 ${current + 1} / ${total} 小节`;
  }

  private updatePlayheadImage(timeSec: number): void {
    const st = this.scorePagerState;
    const midi = this.currentMidi;
    if (!st || !midi) { this.resetStaffScroll(); return; }
    if (timeSec >= midi.duration - 1e-3 || timeSec < 0) { this.resetStaffScroll(); return; }
    const ticks = midi.header.secondsToTicks(Math.max(0, timeSec));
    const progress = Math.min(1, Math.max(0, ticks / midi.durationTicks));
    this.scrollStaffToProgress(progress);
    const m = Math.floor(ticks / st.ctx.ticksPerMeasure);
    this.updateMeasureInfo(Math.min(m, st.nMeas - 1), st.nMeas);
  }

  private updatePlayheadOriginal(timeSec: number): void {
    const st = this.scorePagerState;
    const midi = this.currentMidi;
    if (!st || !midi) { this.hideScorePlayhead(); return; }
    if (timeSec >= midi.duration - 1e-3 || timeSec < 0) { this.hideScorePlayhead(); return; }

    const ticks = midi.header.secondsToTicks(Math.max(0, timeSec));
    let m = Math.floor(ticks / st.ctx.ticksPerMeasure);
    if (m < 0) m = 0;
    if (m >= st.nMeas) m = st.nMeas - 1;
    this.updateMeasureInfo(m, st.nMeas);

    const measureStartTick = m * st.ctx.ticksPerMeasure;
    const progress = Math.min(1, Math.max(0, (ticks - measureStartTick) / st.ctx.ticksPerMeasure));
    const measuresPerRow = SCORE_LAYOUT.measuresPerRow;
    const colInRow = m % measuresPerRow;

    for (const row of this.scoreEl.querySelectorAll<HTMLElement>('.score-measure')) {
      const ph = row.querySelector<HTMLElement>('.playhead');
      if (!ph) continue;
      const midx = Number(row.dataset.measureIndex);
      if (midx !== m) { ph.classList.remove('is-visible'); continue; }
      const hasHeader = row.dataset.hasStaffHeader === '1';
      ph.style.left = `${playheadXInMeasureOverlay(measuresPerRow, st.measureWidth, colInRow, hasHeader, progress)}px`;
      ph.classList.add('is-visible');
    }
  }
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function noteRange(notes: FlatNote[]): { min: number; max: number } {
  if (notes.length === 0) return { min: 57, max: 72 };
  let min = 127;
  let max = 0;
  for (const n of notes) {
    min = Math.min(min, n.midi);
    max = Math.max(max, n.midi);
  }
  return { min: Math.max(21, min - 2), max: Math.min(108, max + 2) };
}
