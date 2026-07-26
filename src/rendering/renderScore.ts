import { Dot, Factory, VoiceMode } from 'vexflow';
import type { StaveNote } from 'vexflow';
import { vexVoiceTimeStr, type Hand, type MeasureContext, type VoiceAtom } from '../core/midiScore';
import { colorForVexKey } from '../core/pitchUtil';
import type { NoteKey, StaffEditState } from '../features/staffEditor';

const BASE_SCORE_HEIGHT = 220;
const BASE_SYSTEM_Y = 12;

/* ── 共享布局计算 ── */

/** 根据音符八度估算上下留白，避免加线音符被 canvas 裁切 */
function canvasPaddingForAtoms(treble: VoiceAtom[], bass: VoiceAtom[]): { padTop: number; padBottom: number } {
  let minOct = 99;
  let maxOct = -99;
  const scan = (atoms: VoiceAtom[]) => {
    for (const a of atoms) {
      if (a.rest) continue;
      for (const k of a.keys) {
        const slash = k.lastIndexOf('/');
        if (slash <= 0) continue;
        const oct = parseInt(k.slice(slash + 1), 10);
        if (!Number.isFinite(oct)) continue;
        minOct = Math.min(minOct, oct);
        maxOct = Math.max(maxOct, oct);
      }
    }
  };
  scan(treble);
  scan(bass);
  if (minOct === 99) minOct = 3;
  if (maxOct === -99) maxOct = 5;

  let padBottom = 32;
  if (minOct <= 3) padBottom += 12;
  if (minOct <= 2) padBottom += 44;
  if (minOct <= 1) padBottom += 40;
  if (minOct <= 0) padBottom += 36;

  let padTop = 20;
  if (maxOct >= 6) padTop += 28;
  if (maxOct >= 7) padTop += 32;

  return { padTop, padBottom };
}

/** 创建小节 overlay（播放头占位） */
function createMeasureOverlays(host: HTMLElement, columns: GrandStaffColumn[], columnWidth: number): void {
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const overlay = document.createElement('div');
    overlay.className = 'score-measure';
    overlay.dataset.measureIndex = String(col.measureIndex);
    overlay.dataset.hasStaffHeader = col.showStaffHeader ? '1' : '0';
    overlay.style.cssText = `position:absolute;left:${i * columnWidth}px;top:0;width:${columnWidth}px;height:100%;pointer-events:none;box-sizing:border-box`;
    const wrap = document.createElement('div');
    wrap.className = 'score-measure-wrap';
    wrap.style.cssText = 'position:relative;height:100%';
    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    playhead.setAttribute('aria-hidden', 'true');
    wrap.appendChild(playhead);
    overlay.appendChild(wrap);
    host.appendChild(overlay);
  }
}

/** 将 atom 转成 StaveNote（共享逻辑） */
function atomToNote(factory: Factory, atom: VoiceAtom, clef: Hand) {
  const keys = atom.rest ? atom.keys : [...atom.keys].sort();
  const note = factory.StaveNote({
    keys,
    duration: atom.duration,
    dots: atom.dots,
    clef,
    autoStem: true,
    ...(atom.rest ? { type: 'r' as const } : {}),
  });
  const nDots = atom.dots ?? 0;
  if (nDots > 0) {
    const dotAttachOpts = !atom.rest && keys.length > 1 ? ({ all: true } as const) : undefined;
    for (let i = 0; i < nDots; i++) {
      Dot.buildAndAttach([note], dotAttachOpts);
    }
  }
  return note;
}

/** 核心：构建 VexFlow System 并返回 noteMap */
function buildSystems(
  factory: Factory,
  columns: GrandStaffColumn[],
  ctx: MeasureContext,
  y0: number,
  segW: number,
  editState?: StaffEditState,
): Map<NoteKey, { note: StaveNote; keyIdx: number }> {
  const noteMap = new Map<NoteKey, { note: StaveNote; keyIdx: number }>();

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const sysX = 12 + i * segW;
    const system = factory.System({
      x: sysX,
      y: y0,
      width: segW,
      spaceBetweenStaves: 10,
      formatOptions: { alignRests: true },
    });

    const staveBarOpts = { leftBar: col.showStaffHeader, rightBar: true };

    // 高音谱
    const trebleVoice = factory.Voice({ time: vexVoiceTimeStr(ctx.timeSig) });
    trebleVoice.setMode(VoiceMode.SOFT);
    for (let ai = 0; ai < col.trebleAtoms.length; ai++) {
      const sn = atomToNote(factory, col.trebleAtoms[ai], 'treble');
      trebleVoice.addTickables([sn]);
      if (!col.trebleAtoms[ai].rest && sn.getKeys().length > 0) {
        const color = colorForVexKey(sn.getKeys()[0]);
        sn.setStyle({ fillStyle: color, strokeStyle: color });
      }
      if (editState && !col.trebleAtoms[ai].rest) {
        for (let ki = 0; ki < sn.getKeys().length; ki++) {
          noteMap.set(`${col.measureIndex}:treble:${ai}:${ki}` as NoteKey, { note: sn, keyIdx: ki });
        }
      }
    }

    // 低音谱
    const bassVoice = factory.Voice({ time: vexVoiceTimeStr(ctx.timeSig) });
    bassVoice.setMode(VoiceMode.SOFT);
    for (let ai = 0; ai < col.bassAtoms.length; ai++) {
      const sn = atomToNote(factory, col.bassAtoms[ai], 'bass');
      bassVoice.addTickables([sn]);
      if (!col.bassAtoms[ai].rest && sn.getKeys().length > 0) {
        const color = colorForVexKey(sn.getKeys()[0]);
        sn.setStyle({ fillStyle: color, strokeStyle: color });
      }
      if (editState && !col.bassAtoms[ai].rest) {
        for (let ki = 0; ki < sn.getKeys().length; ki++) {
          noteMap.set(`${col.measureIndex}:bass:${ai}:${ki}` as NoteKey, { note: sn, keyIdx: ki });
        }
      }
    }

    let trebleStave = system.addStave({ voices: [trebleVoice], options: staveBarOpts });
    if (col.showStaffHeader) {
      trebleStave = trebleStave.addClef('treble').addTimeSignature(ctx.timeSigStr);
    }

    let bassStave = system.addStave({ voices: [bassVoice], options: staveBarOpts });
    if (col.showStaffHeader) {
      bassStave = bassStave.addClef('bass').addTimeSignature(ctx.timeSigStr);
    }

    if (i === 0) {
      system.addConnector('brace');
    }
    system.addConnector('singleRight');
    system.addConnector('singleLeft');
  }

  return noteMap;
}

/** 应用编辑注解（符尾方向、连线、连尾、指法、选中高亮） */
function applyEditDecorations(
  factory: Factory,
  noteMap: Map<NoteKey, { note: StaveNote; keyIdx: number }>,
  editState?: StaffEditState,
  selectedNoteKeys?: Set<NoteKey>,
): void {
  if (!editState) {
    // 仅选中高亮
    if (selectedNoteKeys) {
      for (const nk of selectedNoteKeys) {
        const entry = noteMap.get(nk);
        if (entry) entry.note.setStyle({ fillStyle: '#e53935', strokeStyle: '#e53935' });
      }
    }
    return;
  }

  // 符尾方向
  for (const [nk, dir] of editState.stemDirections) {
    const entry = noteMap.get(nk);
    if (entry) entry.note.setStemDirection(dir);
  }

  // 连音线
  for (const slur of editState.slurs) {
    const from = noteMap.get(slur.from);
    const to = noteMap.get(slur.to);
    if (from && to) {
      factory.StaveTie({
        from: from.note, to: to.note,
        firstIndexes: [from.keyIdx], lastIndexes: [to.keyIdx],
      });
    }
  }

  // 连尾
  for (const tie of editState.ties) {
    const pf = tie.from.split(':'), pt = tie.to.split(':');
    if (pf[0] !== pt[0] || pf[1] !== pt[1]) continue;
    const sA = Math.min(Number(pf[2]), Number(pt[2]));
    const eA = Math.max(Number(pf[2]), Number(pt[2]));
    const seen = new Set<StaveNote>();
    const beamNotes: StaveNote[] = [];
    for (let ai = sA; ai <= eA; ai++) {
      const prefix = `${pf[0]}:${pf[1]}:${ai}:`;
      for (const [nk, entry] of noteMap) {
        if (nk.startsWith(prefix) && !seen.has(entry.note)) {
          seen.add(entry.note);
          beamNotes.push(entry.note);
        }
      }
    }
    if (beamNotes.length >= 2) factory.Beam({ notes: beamNotes });
  }

  // 指法编号（有符尾时放在左侧避免遮挡）
  for (const [nk, finger] of editState.fingerNumbers) {
    const entry = noteMap.get(nk);
    if (entry) {
      const dur = entry.note.getDuration();
      const hasFlag = ['8', '16', '32', '64'].includes(dur);
      const fing = factory.Fingering({ number: String(finger), position: hasFlag ? 'left' : 'above' });
      entry.note.addModifier(fing, entry.keyIdx);
    }
  }

  // 选中高亮
  if (selectedNoteKeys) {
    for (const nk of selectedNoteKeys) {
      const entry = noteMap.get(nk);
      if (entry) entry.note.setStyle({ fillStyle: '#e53935', strokeStyle: '#e53935' });
    }
  }
}

/* ── 公开 API ── */

export type GrandStaffColumn = {
  measureIndex: number;
  trebleAtoms: VoiceAtom[];
  bassAtoms: VoiceAtom[];
  showStaffHeader: boolean;
};

/**
 * 与 {@link renderGrandStaffRowSVG} 中 VexFlow System（x≈12、segW、行内相接）一致；
 * 坐标为「单行内该小节 overlay 局部」，与绝对定位的 column 左缘对齐。
 */
export function playheadXInMeasureOverlay(
  measuresInRow: number,
  columnWidth: number,
  columnIndexInRow: number,
  hasStaffHeader: boolean,
  progress01: number,
): number {
  const n = Math.max(1, measuresInRow);
  const totalW = n * columnWidth;
  const segW = Math.max(40, Math.floor((totalW - 24) / n));
  const systemLocalLeft = 12 + columnIndexInRow * (segW - columnWidth);
  const innerLeft = hasStaffHeader ? 84 : 14;
  const rightPad = 12;
  const span = Math.max(12, segW - innerLeft - rightPad);
  const p = Math.min(1, Math.max(0, progress01));
  return systemLocalLeft + innerLeft + p * span;
}

/**
 * 将一行内多小节渲染成图片（Canvas → data URL → <img>）。
 * `columnWidth` 为版面分配给每小节的宽度。
 * `hideOverlays` 为 true 时不生成播放头 overlay。
 */
export function renderGrandStaffRow(
  container: HTMLElement,
  columns: GrandStaffColumn[],
  ctx: MeasureContext,
  columnWidth: number,
  hideOverlays = false,
  editState?: StaffEditState,
  selectedNoteKeys?: Set<NoteKey>,
): { height: number; totalWidth: number } {
  const n = columns.length;
  if (n === 0) return { height: 0, totalWidth: 0 };

  // 布局计算
  let maxPadTop = 0;
  let maxPadBottom = 0;
  for (const c of columns) {
    const p = canvasPaddingForAtoms(c.trebleAtoms, c.bassAtoms);
    maxPadTop = Math.max(maxPadTop, p.padTop);
    maxPadBottom = Math.max(maxPadBottom, p.padBottom);
  }
  const y0 = BASE_SYSTEM_Y + maxPadTop;
  const height = BASE_SCORE_HEIGHT + maxPadTop + maxPadBottom;
  const totalWidth = n * columnWidth;
  const segW = Math.max(40, Math.floor((totalWidth - 24) / n));

  const host = document.createElement('div');
  host.className = 'score-row-host';
  host.style.cssText = `position:relative;width:${totalWidth}px;height:${height}px;flex-shrink:0`;

  // 离屏 Canvas
  const canvasId = `vf-canvas-${Math.random().toString(36).slice(2)}`;
  const canvas = document.createElement('canvas');
  canvas.id = canvasId;
  canvas.width = totalWidth;
  canvas.height = height;
  canvas.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px';
  host.appendChild(canvas);

  if (!hideOverlays) {
    createMeasureOverlays(host, columns, columnWidth);
  }
  container.appendChild(host);

  // VexFlow 绘制
  const factory = new Factory({
    renderer: { elementId: canvasId, width: totalWidth, height },
  });
  const noteMap = buildSystems(factory, columns, ctx, y0, segW, editState);
  applyEditDecorations(factory, noteMap, editState, selectedNoteKeys);
  factory.draw();

  // 导出 Canvas → PNG → <img>
  const img = document.createElement('img');
  img.src = canvas.toDataURL('image/png');
  img.alt = '乐谱';
  img.style.cssText = `display:block;width:${totalWidth}px;height:${height}px`;
  host.insertBefore(img, canvas);
  host.removeChild(canvas);

  return { height: height + 8, totalWidth };
}

/**
 * 原始 SVG 渲染：VexFlow 内联 SVG + 小节播放头 overlay。
 * 用于 "original" 渲染模式。
 */
export function renderGrandStaffRowSVG(
  container: HTMLElement,
  columns: GrandStaffColumn[],
  ctx: MeasureContext,
  columnWidth: number,
  editState?: StaffEditState,
  selectedNoteKeys?: Set<NoteKey>,
): number {
  const n = columns.length;
  if (n === 0) return 0;

  // 布局计算
  let maxPadTop = 0;
  let maxPadBottom = 0;
  for (const c of columns) {
    const p = canvasPaddingForAtoms(c.trebleAtoms, c.bassAtoms);
    maxPadTop = Math.max(maxPadTop, p.padTop);
    maxPadBottom = Math.max(maxPadBottom, p.padBottom);
  }
  const y0 = BASE_SYSTEM_Y + maxPadTop;
  const height = BASE_SCORE_HEIGHT + maxPadTop + maxPadBottom;
  const totalWidth = n * columnWidth;
  const segW = Math.max(40, Math.floor((totalWidth - 24) / n));

  const host = document.createElement('div');
  host.className = 'score-row-host';
  host.style.position = 'relative';
  host.style.width = `${totalWidth}px`;
  host.style.flexShrink = '0';

  const vfId = `vf-row-${Math.random().toString(36).slice(2)}`;
  const vfWrap = document.createElement('div');
  vfWrap.className = 'vf-wrap';
  vfWrap.id = vfId;
  host.appendChild(vfWrap);

  createMeasureOverlays(host, columns, columnWidth);
  container.appendChild(host);

  const factory = new Factory({
    renderer: { elementId: vfId, width: totalWidth, height },
  });
  const noteMap = buildSystems(factory, columns, ctx, y0, segW, editState);
  applyEditDecorations(factory, noteMap, editState, selectedNoteKeys);
  factory.draw();

  // 为每个音符符头创建精确 hit area（用于右键指法菜单和编辑选择）
  if (editState) {
    const hostRect = host.getBoundingClientRect();
    const byNote = new Map();
    for (const [nk, { note, keyIdx }] of noteMap) {
      const arr = byNote.get(note) ?? [];
      arr.push({ keyIdx, nk });
      byNote.set(note, arr);
    }
    for (const [note, entries] of byNote) {
      const rootEl = note.getSVGElement();
      if (!rootEl) continue;
      const textEls = rootEl.querySelectorAll('text');
      for (const entry of entries) {
        const t = textEls[entry.keyIdx];
        if (!t) continue;
        const r = t.getBoundingClientRect();
        const hit = document.createElement('div');
        hit.className = 'note-hitarea';
        hit.dataset.noteKey = entry.nk;
        const cursorStyle = selectedNoteKeys ? 'cursor:pointer;' : 'cursor:default;';
        hit.style.cssText = `position:absolute;left:${r.left - hostRect.left}px;top:${r.top - hostRect.top}px;width:${r.width}px;height:${r.height}px;${cursorStyle}z-index:5;background:transparent`;
        host.appendChild(hit);
      }
    }
  }

  return height + 8;
}
