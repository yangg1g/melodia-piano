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
  assignNoteKeys,
  type FlatNote,
} from '../core/midiScore';
import { playheadXInMeasureOverlay, renderGrandStaffRow, renderGrandStaffRowSVG, type GrandStaffColumn } from '../rendering/renderScore';
import { applyKeyVisuals, createPianoKeyboard } from '../rendering/pianoKeyboard';
import { autoAssignFingers } from '../core/fingerAssigner';
import { detectChord } from '../core/chordDetector';
import type { FallingNotesHandle } from '../rendering/fallingNotes';
import { playNotes, type PlaybackController } from '../features/playback';
import { startKeyboardPractice } from '../features/keyboardPractice';
import { createStaffEditState, type EditTool } from '../features/staffEditor';
import { ScoringEngine } from '../core/scoring';
import { ensurePiano } from '../audio/salamanderPiano';
import type { PlayMode, PlayHistoryEntry } from '../core/types';
import { loadSettings } from './settings';
import { addHistoryEntry, getHistoryForSong } from './history';
import { showResultScreen, type ResultPageElements } from './resultScreen';
import { countdown } from './countdown';
import { updateProgressBar, resetProgressBar } from './progressBar';
import { updateScoreUI } from './scoreDisplay';
import { MidiSetup } from './midiSetup';
import { PracticeControls, type MeasureErrorInfo } from './practiceControls';

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
  chordDisplay: HTMLDivElement;
  chordDisplayNotes: HTMLSpanElement;
  chordDisplayChord: HTMLSpanElement;
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
  /** 当前曲谱的指法映射表（MIDI → 手指编号 1-5） */
  currentFingerMap: Map<number, number> = new Map();

  // 播放状态
  playback: PlaybackController | null = null;
  seeking = false;
  finalWallTimeSec = 0;
  /** 最后一次键盘弹奏的录制事件（用于回放） */
  lastRecordedEvents: import('../features/playback').MidiEventRecord[] = [];
  /** 最后一次弹奏的模式（用于回放时匹配正确的 freePlay） */
  lastRecordedMode: string = '';

  // 乐谱状态
  scorePagerState: ScorePagerState | null = null;
  staffEditState = createStaffEditState();
  editModeActive = false;
  editTool: EditTool = 'select';
  selectedNoteKeys = new Set<string>();
  selDragStart: { x: number; y: number } | null = null;
  selRectEl: HTMLDivElement | null = null;
  /** 右键指法弹出菜单 */
  fingerMenuEl: HTMLDivElement;
  /** 当前右键点击的音符 noteKey */
  private fingerMenuNoteKey: string | null = null;

  // 乐谱状态
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
    leftPanel: document.querySelector<HTMLDivElement>('#practice-left-panel')!,
    leftContent: document.querySelector<HTMLDivElement>('#practice-left-content')!,
    groupSizeInput: document.querySelector<HTMLInputElement>('#practice-group-size-input')!,
  });
  practiceActive = false;
  practiceRestarting = false;
  practiceLoopNotes: FlatNote[] = [];
  practiceLoopStartFn: (() => void) | null = null;
  practiceLoopDurationSec = 0;
  /** 当前练习循环在原曲中的起始时间（秒），用于将 loop-relative NoteResult.time 映射回原曲小节 */
  private practiceLoopStartTimeSec = 0;
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
    chordDisplay: HTMLDivElement;
    chordDisplayNotes: HTMLSpanElement;
    chordDisplayChord: HTMLSpanElement;
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
    this.chordDisplay = elements.chordDisplay;
    this.chordDisplayNotes = elements.chordDisplayNotes;
    this.chordDisplayChord = elements.chordDisplayChord;
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
    // 创建右键指法弹出菜单
    this.fingerMenuEl = this.createFingerMenu();
    // 下落音符点击回调
    this.fallingNotes.setOnNoteClick((noteKey, midi) => this.handleFallingNoteClick(noteKey, midi));
    this.practice.onJumpToMeasure = (measureStart, measureEnd) => {
      this.practice.measureStart = measureStart;
      this.practice.measureEnd = measureEnd;
      this.practice.updateUI();
      this.restartPracticeLoop();
    };
    this.initEvents();
  }

  /* ── 事件绑定 ── */
  private initEvents(): void {
    this.btnPlay.addEventListener('click', () => this.startPlayFrom(0));
    this.btnStop.addEventListener('click', () => this.stopPlayback());
    this.btnEdit.addEventListener('click', () => this.toggleEditMode());
    this.btnFinger.addEventListener('click', () => this.setEditTool('select', '指法编辑：左键点击五线谱音符弹出指法面板（1-5 / ✕清除），自动保存'));
    this.btnSlur.addEventListener('click', () => { this.setEditTool('slur', '连音编辑：依次单击两个音符创建连线'); this.selectedNoteKeys.clear(); this.renderAll(); });
    this.btnTie.addEventListener('click', () => { this.setEditTool('tie', '连尾编辑：依次单击两个相邻音符将其符杆/符尾相连'); this.selectedNoteKeys.clear(); this.renderAll(); });
    this.btnStem.addEventListener('click', () => this.handleStemToggle());
    this.btnSaveEdits.addEventListener('click', () => this.saveEdits());

    // 进度条
    let wasPlayingBeforeSeek = false;
    this.progressBar.addEventListener('input', () => {
      if (this.getPlayMode() === 'keyboard' && !this.practiceActive) return;
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
      const timeSec = pct * this.totalDurationSec;
      this.seekPreview(timeSec);
    });

    this.progressBar.addEventListener('change', () => {
      if (this.getPlayMode() === 'keyboard' && !this.practiceActive) return;
      this.seeking = false;
      if (!this.currentMidi || this.flatNotes.length === 0) return;
      const pct = Number(this.progressBar.value) / 1000;

      if (this.practiceActive) {
        // 练习模式：跳到对应小节重新开始
        const timeSec = pct * this.totalDurationSec;
        const midi = this.currentMidi;
        const ctx = getMeasureContext(midi);
        const ticksPerMeasure = ctx.ticksPerMeasure;
        const absTick = midi.header.secondsToTicks(timeSec);
        const targetMeasure = Math.floor(absTick / ticksPerMeasure);
        this.practice.measureStart = this.practice.clampMeasure(targetMeasure);
        this.practice.measureEnd = this.practice.measureStart;
        this.practice.updateUI();
        wasPlayingBeforeSeek = false;
        this.restartPracticeLoop();
        return;
      }

      const dur = this.totalDurationSec;
      const timeSec = pct * dur;
      updateProgressBar(this.progressBar, this.progressTime, timeSec, dur, false);
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

    // 合并小节数变更
    this.practice.elements.groupSizeInput.addEventListener('change', () => {
      const v = parseInt(this.practice.elements.groupSizeInput.value, 10);
      if (!isNaN(v) && v >= 1) {
        this.practice.measureGroupSize = v;
        this.loadHistoryAnalysis();
        if (this.practice.records.length > 0) this.updateMeasureErrors();
      }
    });

    // 窗口大小变化时重新定位左侧面板
    window.addEventListener('resize', () => {
      if (this.practiceActive && !this.practice.elements.leftPanel.hidden) {
        const barRect = this.practice.elements.controlsBar.getBoundingClientRect();
        this.practice.elements.leftPanel.style.top = `${barRect.bottom + 8}px`;
        this.practice.elements.leftPanel.style.maxHeight = `calc(100% - ${barRect.bottom + 24}px)`;
      }
    });

    // 编辑模式键盘事件
    document.addEventListener('keydown', (e) => this.handleEditKeydown(e));

    // 音符选择 + 框选
    this.scoreEl.addEventListener('mousedown', (e) => this.handleScoreMouseDown(e));
    this.scoreScrollEl.addEventListener('mousemove', (e) => this.handleScoreMouseMove(e));
    document.addEventListener('mouseup', () => this.handleScoreMouseUp());

    // 右键指法菜单
    this.scoreScrollEl.addEventListener('contextmenu', (e) => this.handleScoreContextMenu(e));

    // 左键指法：document 委托，确保事件不被 DOM 结构拦截
    // 左键指法：document 委托（五线谱音符）
    document.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      // 五线谱音符（original 模式）
      const hit = (e.target as HTMLElement).closest<HTMLElement>('.note-hitarea');
      if (hit?.dataset.noteKey) {
        this.handleScoreNoteClick(hit.dataset.noteKey, hit);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // 点击其他位置关闭菜单
      if (!this.fingerMenuEl.contains(e.target as Node)) {
        this.hideFingerMenu();
      }
    });
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
      this.keyboardHint.textContent = '根据 MIDI 生成的五线谱（高音 / 低音谱表）。琴键上方为下落式音符（绿左 / 蓝右；白键稍亮、黑键更深）。键盘高亮同上。左键点击音符可标注指法。';
    } else if (mode === 'keyboard') {
      this.keyboardHint.textContent = 'MIDI 跟弹：绿色 / 蓝色描边为当前应弹的左 / 右手音；弹对后条缩短并发声前进；紫红色外圈为正在按下的键，错音不出声。左键点击音符可标注指法。';
    } else {
      this.keyboardHint.textContent = '普通模式：自动播放曲目，可同时使用 MIDI 键盘弹奏，实时判定计分。左键点击音符可标注指法。';
    }
  }

  /** 更新和弦显示：根据当前按下的 MIDI 键显示和弦信息 */
  updateChordDisplay(pressed: Set<number>): void {
    if (pressed.size === 0) {
      this.chordDisplay.hidden = true;
      return;
    }
    this.chordDisplay.hidden = false;

    const chord = detectChord(pressed);
    if (!chord) {
      this.chordDisplayNotes.textContent = '';
      this.chordDisplayChord.textContent = '';
      return;
    }

    const lang = loadSettings().chordLang;
    this.chordDisplayNotes.textContent = chord.noteNames.join(' ');

    if (chord.type) {
      // 有和弦类型：显示和弦名
      if (lang === 'zh') {
        this.chordDisplayChord.textContent = chord.cnName
          ? `${chord.rootName}${chord.cnName}和弦`
          : chord.fullName;
      } else {
        this.chordDisplayChord.textContent = chord.fullName;
      }
    } else if (pressed.size === 1) {
      // 单音
      this.chordDisplayChord.textContent = lang === 'zh'
        ? `${chord.rootName} 单音`
        : chord.rootName;
    } else {
      this.chordDisplayChord.textContent = chord.fullName;
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
    this.progressBar.style.pointerEvents = (isKeyboard && !this.practiceActive) ? 'none' : '';
    this.progressBar.style.opacity = (isKeyboard && !this.practiceActive) ? '0.55' : '';
  }

  /** 自动分配指法：基于音高范围计算 MIDI → 手指编号 */
  autoAssignFingerNumbers(): void {
    if (!this.currentMidi || this.flatNotes.length === 0) return;
    const result = autoAssignFingers(this.flatNotes, this.currentMidi);
    this.currentFingerMap = result.midiToFinger;
    this.fallingNotes.setFingerData(this.staffEditState.fingerNumbers, this.flatNotes);

    // 重新渲染以在五线谱上显示指法
    this.renderAll();

    // 同时将指法写入 NoteKey 格式的 staffEditState，使乐谱也可显示
    const ctx = getMeasureContext(this.currentMidi);
    const totalMeasures = measureCount(this.currentMidi, ctx);

    for (let mi = 0; mi < totalMeasures; mi++) {
      const trebleAtoms = buildAtomsForHand(this.flatNotes, this.currentMidi, 'treble', ctx, mi);
      const bassAtoms = buildAtomsForHand(this.flatNotes, this.currentMidi, 'bass', ctx, mi);

      for (const [hand, atoms] of [['treble', trebleAtoms], ['bass', bassAtoms]] as const) {
        for (let ai = 0; ai < atoms.length; ai++) {
          const atom = atoms[ai];
          if (atom.rest) continue;
          for (let ki = 0; ki < atom.keys.length; ki++) {
            const vexKey = atom.keys[ki];
            // 在 flatNotes 中找到对应 MIDI
            const measureStartSec = mi * ctx.secPerMeasure;
            const measureEndSec = (mi + 1) * ctx.secPerMeasure;
            const fn = this.flatNotes.find(n => {
              return n.vexKey === vexKey
                && n.time >= measureStartSec && n.time < measureEndSec
                && assignHandForNote(n, this.currentMidi!) === hand;
            });
            if (fn) {
              const finger = result.timeFinger.get(`${fn.midi}:${fn.time.toFixed(3)}`);
              if (finger !== undefined) {
                const nk = `${mi}:${hand}:${ai}:${ki}`;
                this.staffEditState.fingerNumbers.set(nk, finger);
              }
            }
          }
        }
      }
    }

    this.keyboardHint.textContent = '已自动分配指法。播放时琴键将显示手指编号（1-5）。';
  }

  /** 从 staffEditState.fingerNumbers（NoteKey 格式）构建 MIDI → 手指的映射 */
  private buildFingerMapFromEditState(): void {
    if (!this.currentMidi) return;
    const ctx = getMeasureContext(this.currentMidi);
    this.currentFingerMap = new Map();

    for (const [nk, finger] of this.staffEditState.fingerNumbers) {
      const [mStr, hand, aStr, kStr] = nk.split(':');
      const mi = Number(mStr);
      const ai = Number(aStr);
      const ki = Number(kStr);

      const atoms = buildAtomsForHand(this.flatNotes, this.currentMidi, hand as 'treble' | 'bass', ctx, mi);
      if (ai < atoms.length) {
        const atom = atoms[ai];
        if (!atom.rest && ki < atom.keys.length) {
          const vexKey = atom.keys[ki];
          const measureStartSec = mi * ctx.secPerMeasure;
          const measureEndSec = (mi + 1) * ctx.secPerMeasure;
          const fn = this.flatNotes.find(n => {
            return n.vexKey === vexKey
              && n.time >= measureStartSec && n.time < measureEndSec
              && assignHandForNote(n, this.currentMidi!) === hand;
          });
          if (fn) {
              this.currentFingerMap.set(fn.midi, finger);
            }
          }
        }
      }
      this.fallingNotes.setFingerData(this.staffEditState.fingerNumbers, this.flatNotes);
    }

  /** 同步指法到下落音符 */
  private syncFingerMapToFallingNotes(): void {
    this.fallingNotes.setFingerData(this.staffEditState.fingerNumbers, this.flatNotes);
  }

  /* ── 乐谱渲染 ── */

  renderAll(midi?: Midi): void {
    const m = midi ?? this.currentMidi;
    if (!m) return;
    this.currentMidi = m;
    this.flatNotes = flattenNotes(m);
    assignNoteKeys(this.flatNotes, m, getMeasureContext(m));
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

    this.renderAll(midi);
    this.syncModeUi();

    // 从 JSON 预置指法加载
    this.loadJsonFingers();
  }

  /** 从 flatNotes 中的 finger 字段加载 JSON 预置指法 */
  private loadJsonFingers(): void {
    let changed = false;
    for (const fn of this.flatNotes) {
      if (fn.finger !== undefined && fn.noteKey) {
        this.staffEditState.fingerNumbers.set(fn.noteKey, fn.finger);
        changed = true;
      }
    }
    if (changed) {
      this.syncFingerMapToFallingNotes();
      this.renderAll();
    }
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
    this.syncModeUi();
    this.practice.elements.controlsBar.hidden = false;
    this.practice.elements.sidePanel.hidden = false;
    this.practice.elements.sideHeader.hidden = false;
    this.practice.elements.sideScores.hidden = false;
    this.practice.elements.sideScores.innerHTML = '';
    this.practice.elements.leftPanel.hidden = false;
    // 动态定位左侧面板：放在 practice-controls-bar 下方
    const barRect = this.practice.elements.controlsBar.getBoundingClientRect();
    this.practice.elements.leftPanel.style.top = `${barRect.bottom + 8}px`;
    this.practice.elements.leftPanel.style.maxHeight = `calc(100% - ${barRect.bottom + 24}px)`;
    this.practice.init(measureCount(midi, getMeasureContext(midi)));
    this.practice.updateUI();
    // 加载历史记录分析
    this.loadHistoryAnalysis();
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
          settings: { fallingSpeed: curSettings.fallingSpeed, playbackSpeed: curSettings.playbackSpeed, difficulty: curSettings.difficulty, offsetAdjustMs: curSettings.offsetAdjustMs },
          noteResults: best.noteResults,
          wrongKeyRecords: best.wrongKeyRecords,
          wallTimeSec: this.finalWallTimeSec || undefined,
          originalDurationSec: undefined,
          recordedEvents: this.lastRecordedEvents.length > 0
            ? this.lastRecordedEvents.map(e => ({ data: Array.from(e.data), wallTimeSec: e.wallTimeSec }))
            : undefined,
        };
        if (this.currentSongFile) {
          try { addHistoryEntry(entry); } catch { /* ignore */ }
        }
        this.pianoPageEl.hidden = true;
        showResultScreen(entry, this.scoringEngine.getMaxTheoreticalScore(), this.resultElements,
          this.lastRecordedEvents.length > 0);
      }
    }

    this.lastRecordedEvents = this.playback?.getRecordedEvents?.() ?? [];
    this.playback?.stop();
    this.playback = null;
    this.hideScorePlayhead();
    if (this.scorePagerState) this.updateMeasureInfo(0, this.scorePagerState.nMeas);
    this.fallingNotes.clear();
    applyKeyVisuals(this.keyEls, {});
    this.chordDisplay.hidden = true;
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

    const onPlaybackEnded = (completed?: boolean) => {
      // 保存录制事件和模式（用于回放）
      this.lastRecordedEvents = this.playback?.getRecordedEvents?.() ?? [];
      this.lastRecordedMode = mode;
      this.hideScorePlayhead();
      this.fallingNotes.clear();
      this.btnPlay.disabled = false;
      this.btnStop.disabled = true;
      this.playback = null;
      resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);

      // 只有完成整首才写入历史
      if (completed && this.getPlayMode() !== 'auto') {
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
          settings: { fallingSpeed: curSettings.fallingSpeed, playbackSpeed: curSettings.playbackSpeed, difficulty: curSettings.difficulty, offsetAdjustMs: curSettings.offsetAdjustMs },
          noteResults: this.scoringEngine.noteResults,
          wrongKeyRecords: this.scoringEngine.wrongKeyRecords,
          wallTimeSec: this.finalWallTimeSec || undefined,
          originalDurationSec: this.totalDurationSec || undefined,
          recordedEvents: this.lastRecordedEvents.length > 0
            ? this.lastRecordedEvents.map(e => ({ data: Array.from(e.data), wallTimeSec: e.wallTimeSec }))
            : undefined,
        };
        if (this.currentSongFile) {
          try { addHistoryEntry(entry); } catch { /* 忽略存储错误 */ }
        }
        // 先隐藏钢琴页，再显示结算画面
        this.pianoPageEl.hidden = true;
        showResultScreen(entry, this.scoringEngine.getMaxTheoreticalScore(), this.resultElements,
          this.lastRecordedEvents.length > 0);
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
      this.practiceLoopStartTimeSec = startTimeSec;
      this.fallingNotes.setLoopRange(startTimeSec, endTimeSec);

      this.practiceLoopNotes = this.flatNotes
        .filter(n => n.ticks >= startTick && n.ticks < endTick)
        .map(n => ({ ...n, time: n.time - startTimeSec, ticks: n.ticks - startTick }));

      this.scoreDisplay.hidden = false;

      const startLoop = () => {
        if (!this.practiceActive) return;

        const holdCount = this.practiceLoopNotes.filter(n => Math.max(0, n.duration) >= 0.05).length;
        this.scoringEngine.reset({ totalNotes: this.practiceLoopNotes.length, holdNoteCount: holdCount });
        this.lastPushedResultIdx = 0;
        updateScoreUI(this.scoringEngine.getState(), this.scoreElements());
        this.practiceCurrentWallSec = 0;

        const onLoopEnded = (_completed?: boolean) => {
          this.hideScorePlayhead();
          this.fallingNotes.clear();
          this.fallingNotes.setLoopRange(this.practiceLoopStartTimeSec, this.practiceLoopStartTimeSec + this.practiceLoopDurationSec);
          this.playback = null;

          if (!this.practiceActive || this.seeking || this.practiceRestarting) {
            this.btnPlay.disabled = false;
            this.btnStop.disabled = true;
            return;
          }
          resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);
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
          this.updateMeasureErrors();

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
            const absTime = this.practiceLoopStartTimeSec + t;
            this.updateScorePlayhead(absTime);
            updateProgressBar(this.progressBar, this.progressTime, absTime, this.totalDurationSec, this.seeking);
            const currentTick = startTick + midi.header.secondsToTicks(t);
            const currentMeasure = Math.floor(currentTick / ticksPerMeasure);
            const loopMeasure = Math.max(0, Math.min(currentMeasure - this.practice.measureStart, this.practice.measureEnd - this.practice.measureStart));
            this.updateMeasureInfo(loopMeasure, this.practice.measureEnd - this.practice.measureStart + 1);
          },
          (s) => this.fallingNotes.updateKeyboardPractice(s),
          this.scoringEngine,
          (state) => { updateScoreUI(state, this.scoreElements()); this.updateTimingDots(); },
          false,
          settings.playbackSpeed,
          (wallSec) => { this.practiceCurrentWallSec = wallSec; },
          (pressed) => this.updateChordDisplay(pressed),
          undefined,
          this.currentFingerMap,
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
      this.lastPushedResultIdx = 0;
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
        (state) => { updateScoreUI(state, this.scoreElements()); this.updateTimingDots(); },
        true,
        settings.playbackSpeed,
        undefined,
        (pressed) => this.updateChordDisplay(pressed),
        undefined,
        this.currentFingerMap,
      );
      return;
    }

    /* ── MIDI 跟弹模式 ── */
    if (mode === 'keyboard') {
      this.scoreDisplay.hidden = false;
      const holdCount = this.flatNotes.filter(n => Math.max(0, n.duration) >= 0.05).length;
      this.scoringEngine.reset({ totalNotes: this.flatNotes.length, holdNoteCount: holdCount });
      this.lastPushedResultIdx = 0;
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
        (state) => { updateScoreUI(state, this.scoreElements()); this.updateTimingDots(); },
        false,
        settings.playbackSpeed,
        (wallSec) => {
          this.finalWallTimeSec = wallSec;
          const refTimeSec = lastGameTimeSec > 0 ? lastGameTimeSec : this.totalDurationSec;
          const pct = refTimeSec > 0 ? Math.max(0, (wallSec / refTimeSec) * 100) : 0;
          this.practiceTime.textContent = `用时 ${formatTime(wallSec)} · ${pct.toFixed(1)}%`;
        },
        (pressed) => this.updateChordDisplay(pressed),
        undefined,
        this.currentFingerMap,
      );
      return;
    }
  }

  /** 用绝对时间统一更新五线谱、进度条、小节信息（拖动时预览用） */
  private seekPreview(timeSec: number): void {
    updateProgressBar(this.progressBar, this.progressTime, timeSec, this.totalDurationSec, false);
    this.updateScorePlayhead(timeSec);
    this.fallingNotes.update(timeSec);
    if (this.currentMidi) {
      const ctx = getMeasureContext(this.currentMidi);
      const tick = this.currentMidi.header.secondsToTicks(Math.max(0, timeSec));
      const m = Math.floor(tick / ctx.ticksPerMeasure);
      const total = measureCount(this.currentMidi, ctx);
      this.updateMeasureInfo(Math.min(m, total - 1), total);
    }
  }

  /** 更新乐谱播放头位置（回放也用到） */
  updateScorePlayhead(sec: number): void {
    if (this.getRenderMode() === 'image') {
      this.updatePlayheadImage(sec);
    } else {
      this.updatePlayheadOriginal(sec);
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

  private async saveEdits(): Promise<void> {
    await this.saveToJson();
    this.btnSaveEdits.textContent = '✓ 已保存';
    setTimeout(() => { this.btnSaveEdits.textContent = '保存'; }, 2000);
  }

  /** 保存指法到 JSON 文件（静默） */
  private async saveFingerEdits(): Promise<void> {
    await this.saveToJson();
  }

  private async saveToJson(): Promise<void> {
    if (!this.currentSongFile || !this.currentMidi) return;
    try {
      // 构建完整的 JSON（包含指法）
      const flatNotes = this.flatNotes;
      const notes = flatNotes.map(n => {
        const finger = n.noteKey ? this.staffEditState.fingerNumbers.get(n.noteKey) : undefined;
        return {
          midi: n.midi, time: n.time, duration: n.duration,
          ticks: n.ticks, durationTicks: n.durationTicks,
          trackIndex: n.trackIndex, vexKey: n.vexKey, velocity: n.velocity,
          ...(finger ? { finger } : {}),
        };
      });

      const data = {
        version: 1,
        name: this.currentSongName,
        duration: this.currentMidi.duration,
        durationTicks: this.currentMidi.durationTicks,
        header: {
          tempos: this.currentMidi.header.tempos.map(t => ({ bpm: t.bpm, ticks: t.ticks })),
          timeSignatures: this.currentMidi.header.timeSignatures.map(ts => ({
            ticks: ts.ticks, timeSignature: ts.timeSignature, measures: ts.measures,
          })),
          ppq: this.currentMidi.header.ppq,
        },
        trackCount: this.currentMidi.tracks.length,
        tracksWithNotes: this.currentMidi.tracks
          .map((t: any, i: number) => (t.notes?.length > 0 ? i : -1))
          .filter((i: number) => i >= 0),
        notes,
        noteCount: notes.length,
        minMidi: notes.length > 0 ? Math.min(...notes.map(n => n.midi)) : 60,
        maxMidi: notes.length > 0 ? Math.max(...notes.map(n => n.midi)) : 84,
      };

      await fetch('/api/songs/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: this.currentSongFile, data }),
      });
    } catch (e) {
      console.error('[saveToJson] error:', e);
    }
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
      this.buildFingerMapFromEditState();
      this.syncFingerMapToFallingNotes();
      this.renderAll();
      this.saveFingerEdits();
    } else if (e.key === '0' || e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      for (const nk of this.selectedNoteKeys) {
        this.staffEditState.fingerNumbers.delete(nk);
        this.staffEditState.slurs = this.staffEditState.slurs.filter(s => s.from !== nk && s.to !== nk);
        this.staffEditState.ties = this.staffEditState.ties.filter(t => t.from !== nk && t.to !== nk);
        this.staffEditState.stemDirections.delete(nk);
      }
      this.buildFingerMapFromEditState();
      this.syncFingerMapToFallingNotes();
      this.selectedNoteKeys.clear();
      this.renderAll();
    }
  }

  private handleScoreMouseDown(e: MouseEvent): void {
    // 仅左键，仅编辑模式，仅 original 渲染
    if (e.button !== 0 || !this.editModeActive || this.getRenderMode() !== 'original') return;

    const hit = (e.target as HTMLElement).closest<HTMLElement>('.note-hitarea');
    if (hit?.dataset.noteKey) {
      const nk = hit.dataset.noteKey;

      // slur / tie 工具：保持原有选择逻辑
      if (this.editTool === 'slur' || this.editTool === 'tie') {
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
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // 框选
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

  /* ── 右键指法菜单 ── */

  private createFingerMenu(): HTMLDivElement {
    const menu = document.createElement('div');
    menu.className = 'finger-menu';
    menu.hidden = true;
    const btns = document.createElement('div');
    btns.className = 'finger-menu-btns';
    for (const f of [1,2,3,4,5]) {
      const btn = document.createElement('button');
      btn.className = 'finger-menu-btn';
      btn.dataset.finger = String(f);
      btn.textContent = String(f);
      btns.appendChild(btn);
    }
    const clearBtn = document.createElement('button');
    clearBtn.className = 'finger-menu-btn finger-menu-btn--clear';
    clearBtn.dataset.finger = '0';
    clearBtn.textContent = '✕';
    btns.appendChild(clearBtn);
    menu.appendChild(btns);

    menu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.finger-menu-btn');
      if (!btn || !this.fingerMenuNoteKey) return;
      e.preventDefault();
      e.stopPropagation();
      const finger = Number(btn.dataset.finger);
      const nk = this.fingerMenuNoteKey;

      if (nk.startsWith('_falling:')) {
        // 下落音符无精确 NoteKey，忽略
        this.syncFingerMapToFallingNotes();
      } else {
        // 五线谱音符：更新 NoteKey → 手指映射
        if (finger === 0) {
          this.staffEditState.fingerNumbers.delete(nk);
        } else {
          this.staffEditState.fingerNumbers.set(nk, finger);
        }
        this.syncFingerMapToFallingNotes();
      }

      // 播放下不重绘乐谱
      if (!this.playback?.isPlaying()) {
        this.renderAll();
      }
      this.hideFingerMenu();
      this.saveFingerEdits();
    });
    document.body.appendChild(menu);
    return menu;
  }

  private handleScoreContextMenu(e: MouseEvent): void {
    if (this.getRenderMode() !== 'original') return;
    this.hideFingerMenu();

    const hit = (e.target as HTMLElement).closest<HTMLElement>('.note-hitarea');
    if (!hit || !hit.dataset.noteKey) return;

    e.preventDefault();
    e.stopPropagation();

    this.fingerMenuNoteKey = hit.dataset.noteKey;

    const menu = this.fingerMenuEl;
    menu.hidden = false;
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    const currentFinger = this.staffEditState.fingerNumbers.get(this.fingerMenuNoteKey);
    menu.querySelectorAll<HTMLButtonElement>('.finger-menu-btn').forEach(b => {
      const f = Number(b.dataset.finger);
      b.classList.toggle('finger-menu-btn--active', f === currentFinger);
    });
  }

  /** 五线谱音符左键点击 → 弹出指法菜单 */
  private handleScoreNoteClick(nk: string, hit: HTMLElement): void {
    this.hideFingerMenu();
    this.fingerMenuNoteKey = nk;

    const rect = hit.getBoundingClientRect();
    const menu = this.fingerMenuEl;
    menu.hidden = false;
    menu.style.left = `${rect.left + rect.width / 2}px`;
    menu.style.top = `${rect.top}px`;

    const currentFinger = this.staffEditState.fingerNumbers.get(nk);
    menu.querySelectorAll<HTMLButtonElement>('.finger-menu-btn').forEach(b => {
      const f = Number(b.dataset.finger);
      b.classList.toggle('finger-menu-btn--active', f === currentFinger);
    });
  }

  private hideFingerMenu(): void {
    this.fingerMenuEl.hidden = true;
    this.fingerMenuNoteKey = null;
  }

  /** 下落音符点击 */
  private handleFallingNoteClick(noteKey: string | null, midi: number): void {
    const nk = noteKey ?? `_falling:${midi}`;

    this.hideFingerMenu();
    this.fingerMenuNoteKey = nk;

    const menu = this.fingerMenuEl;
    menu.hidden = false;
    menu.style.left = `${Math.min(window.innerWidth - 120, Math.max(60, window.innerWidth / 2))}px`;
    menu.style.top = `${window.innerHeight / 2}px`;

    let currentFinger: number | undefined;
    if (noteKey) {
      currentFinger = this.staffEditState.fingerNumbers.get(noteKey);
    }
    menu.querySelectorAll<HTMLButtonElement>('.finger-menu-btn').forEach(b => {
      const f = Number(b.dataset.finger);
      b.classList.toggle('finger-menu-btn--active', f === currentFinger);
    });
  }

  private handlePracticeStartChange(newVal: number): void {
    this.practice.handleStartChange(newVal);
    this.restartPracticeLoop();
  }

  private handlePracticeEndChange(newVal: number): void {
    this.practice.handleEndChange(newVal);
    this.restartPracticeLoop();
  }

  /** 加载历史记录并做全曲分析（进入练习模式时调用） */
  private loadHistoryAnalysis(): void {
    if (!this.currentMidi || !this.currentSongFile) return;
    const midi = this.currentMidi;
    const ctx = getMeasureContext(midi);
    const ticksPerMeasure = ctx.ticksPerMeasure;
    if (ticksPerMeasure <= 0) return;
    const totalMeasures = measureCount(midi, ctx);

    // 统计全曲各小节音符数
    const measureTotalNotes = new Map<number, number>();
    for (const n of this.flatNotes) {
      const mIdx = Math.floor(n.ticks / ticksPerMeasure);
      measureTotalNotes.set(mIdx, (measureTotalNotes.get(mIdx) ?? 0) + 1);
    }

    const measureStats = new Map<number, { missCount: number; badCount: number; wrongCount: number }>();
    const initM = (idx: number) => {
      if (!measureStats.has(idx)) measureStats.set(idx, { missCount: 0, badCount: 0, wrongCount: 0 });
      return measureStats.get(idx)!;
    };

    // 扫描历史记录
    const historyEntries = getHistoryForSong(this.currentSongFile);
    for (const entry of historyEntries) {
      for (const nr of entry.noteResults ?? []) {
        // 历史记录中 NoteResult.time 是原始 MIDI 时间
        const tick = midi.header.secondsToTicks(nr.time);
        const mIdx = Math.floor(tick / ticksPerMeasure);
        if (mIdx >= 0 && mIdx < totalMeasures) {
          const s = initM(mIdx);
          if (nr.judgement === 'MISS') s.missCount++;
          else if (nr.judgement === 'BAD') s.badCount++;
        }
      }
      for (const wr of entry.wrongKeyRecords ?? []) {
        const tick = midi.header.secondsToTicks(wr.timeSec);
        const mIdx = Math.floor(tick / ticksPerMeasure);
        if (mIdx >= 0 && mIdx < totalMeasures) {
          initM(mIdx).wrongCount++;
        }
      }
    }

    // 构建排序列表（按 groupSize 合并）
    const groupSize = this.practice.measureGroupSize || 1;
    const errors: MeasureErrorInfo[] = [];
    for (let gStart = 0; gStart < totalMeasures; gStart += groupSize) {
      const gEnd = Math.min(gStart + groupSize - 1, totalMeasures - 1);
      let missCount = 0, badCount = 0, wrongCount = 0, totalNotes = 0;
      for (let i = gStart; i <= gEnd; i++) {
        const stats = measureStats.get(i);
        if (stats) {
          missCount += stats.missCount;
          badCount += stats.badCount;
          wrongCount += stats.wrongCount;
        }
        totalNotes += measureTotalNotes.get(i) ?? 0;
      }
      const ec = missCount + badCount + wrongCount;
      if (ec > 0) {
        errors.push({
          measureIndex: gStart,
          measureNumber: gStart + 1,
          measureEndIndex: gEnd,
          errorCount: ec,
          missCount,
          badCount,
          wrongCount,
          totalNotes,
        });
      }
    }
    errors.sort((a, b) => b.errorCount - a.errorCount);
    this.practice.setMeasureErrors(errors);
  }

  /** 分析所有练习轮记录，计算各小节错误数并更新左侧面板 */
  private updateMeasureErrors(): void {
    if (!this.currentMidi || !this.currentSongFile) return;
    if (!this.currentMidi) return;
    const midi = this.currentMidi;
    const ctx = getMeasureContext(midi);
    const ticksPerMeasure = ctx.ticksPerMeasure;
    if (ticksPerMeasure <= 0) return;
    const totalMeasures = measureCount(midi, ctx);
    const startTimeSec = this.practiceLoopStartTimeSec;

    // 重新调用 loadHistoryAnalysis 获得历史基准，然后叠加当前轮数据
    // 注：当前轮的 NoteResult.time 是 loop-relative
    const measureTotalNotes = new Map<number, number>();
    for (const n of this.flatNotes) {
      const mIdx = Math.floor(n.ticks / ticksPerMeasure);
      measureTotalNotes.set(mIdx, (measureTotalNotes.get(mIdx) ?? 0) + 1);
    }

    const measureStats = new Map<number, { missCount: number; badCount: number; wrongCount: number }>();
    const initM = (idx: number) => {
      if (!measureStats.has(idx)) measureStats.set(idx, { missCount: 0, badCount: 0, wrongCount: 0 });
      return measureStats.get(idx)!;
    };

    // 1) 历史记录
    const historyEntries = getHistoryForSong(this.currentSongFile ?? '');
    for (const entry of historyEntries) {
      for (const nr of entry.noteResults ?? []) {
        const tick = midi.header.secondsToTicks(nr.time);
        const mIdx = Math.floor(tick / ticksPerMeasure);
        if (mIdx >= 0 && mIdx < totalMeasures) {
          const s = initM(mIdx);
          if (nr.judgement === 'MISS') s.missCount++;
          else if (nr.judgement === 'BAD') s.badCount++;
        }
      }
      for (const wr of entry.wrongKeyRecords ?? []) {
        const tick = midi.header.secondsToTicks(wr.timeSec);
        const mIdx = Math.floor(tick / ticksPerMeasure);
        if (mIdx >= 0 && mIdx < totalMeasures) {
          initM(mIdx).wrongCount++;
        }
      }
    }

    // 2) 当前轮记录（NoteResult.time 是 loop-relative）
    for (const record of this.practice.records) {
      for (const nr of record.noteResults) {
        const originalTime = startTimeSec + nr.time;
        const tick = midi.header.secondsToTicks(originalTime);
        const mIdx = Math.floor(tick / ticksPerMeasure);
        if (mIdx >= 0 && mIdx < totalMeasures) {
          const s = initM(mIdx);
          if (nr.judgement === 'MISS') s.missCount++;
          else if (nr.judgement === 'BAD') s.badCount++;
        }
      }
      for (const wr of record.wrongKeyRecords) {
        const originalTime = startTimeSec + wr.timeSec;
        const tick = midi.header.secondsToTicks(originalTime);
        const mIdx = Math.floor(tick / ticksPerMeasure);
        if (mIdx >= 0 && mIdx < totalMeasures) {
          initM(mIdx).wrongCount++;
        }
      }
    }

    // 构建排序列表（按 groupSize 合并）
    const groupSize = this.practice.measureGroupSize || 1;
    const errors: MeasureErrorInfo[] = [];
    for (let gStart = 0; gStart < totalMeasures; gStart += groupSize) {
      const gEnd = Math.min(gStart + groupSize - 1, totalMeasures - 1);
      let missCount = 0, badCount = 0, wrongCount = 0, totalNotes = 0;
      for (let i = gStart; i <= gEnd; i++) {
        const stats = measureStats.get(i);
        if (stats) {
          missCount += stats.missCount;
          badCount += stats.badCount;
          wrongCount += stats.wrongCount;
        }
        totalNotes += measureTotalNotes.get(i) ?? 0;
      }
      const ec = missCount + badCount + wrongCount;
      if (ec > 0) {
        errors.push({
          measureIndex: gStart,
          measureNumber: gStart + 1,
          measureEndIndex: gEnd,
          errorCount: ec,
          missCount,
          badCount,
          wrongCount,
          totalNotes,
        });
      }
    }
    errors.sort((a, b) => b.errorCount - a.errorCount);
    this.practice.setMeasureErrors(errors);
  }

  restartPracticeLoop(): void {
    if (!this.practiceActive || !this.currentMidi || !this.practiceLoopStartFn) return;
    this.practiceRestarting = true;
    this.playback?.stop();
    this.playback = null;
    this.fallingNotes.clear();
    // 不调 hideScorePlayhead，而是直接跳到新位置
    this.updateMeasureInfo(0, this.practice.measureEnd - this.practice.measureStart + 1);

    const midi = this.currentMidi;
    const ctx = getMeasureContext(midi);
    const ticksPerMeasure = ctx.ticksPerMeasure;
    const startTick = this.practice.measureStart * ticksPerMeasure;
    const endTick = (this.practice.measureEnd + 1) * ticksPerMeasure;
    const startTimeSec = midi.header.ticksToSeconds(startTick);
    const endTimeSec = midi.header.ticksToSeconds(endTick);
    this.practiceLoopDurationSec = endTimeSec - startTimeSec;
    this.practiceLoopStartTimeSec = startTimeSec;
    this.fallingNotes.setLoopRange(startTimeSec, endTimeSec);

    // 滚动乐谱 + 更新进度条到循环起始位置
    this.seekPreview(startTimeSec);

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

  /** 已推入预览线的最新结果索引 */
  private lastPushedResultIdx = 0;

  /** 更新预览线命中标记 */
  private updateTimingDots(): void {
    const results = this.scoringEngine.noteResults;

    // 推送新命中到预览线（应用偏移补偿，使位置反映实际判定）
    const wallSec = performance.now() / 1000;
    for (let i = this.lastPushedResultIdx; i < results.length; i++) {
      const nr = results[i];
      if (nr.judgement === 'MISS') continue;
      const adjustedMs = nr.offsetMs - this.scoringEngine.offsetAdjustMs;
      this.fallingNotes.pushTimingMarker(adjustedMs, nr.judgement as 'PERFECT' | 'OK' | 'BAD');
    }
    this.lastPushedResultIdx = results.length;
    this.fallingNotes.tickMarkerTime(wallSec);
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
