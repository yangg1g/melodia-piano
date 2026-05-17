import { Dot, Factory, VoiceMode } from 'vexflow';
import { vexVoiceTimeStr, type Hand, type MeasureContext, type VoiceAtom } from './midiScore';
import type { NoteKey, StaffEditState } from './staffEditor';

const BASE_SCORE_HEIGHT = 220;
const BASE_SYSTEM_Y = 12;

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

function atomToNote(factory: Factory, atom: VoiceAtom, clef: Hand) {
  const keys = atom.rest ? atom.keys : [...atom.keys].sort();
  const note = atom.rest
    ? factory.StaveNote({
        keys,
        duration: atom.duration,
        dots: atom.dots,
        type: 'r',
        clef,
        autoStem: true,
      })
    : factory.StaveNote({
        keys,
        duration: atom.duration,
        dots: atom.dots,
        clef,
        autoStem: true,
      });

  /** VexFlow 5：`dots` 只参与时值 tick；可见附点需挂 {@link Dot} 修饰符（与 EasyScore 一致） */
  const nDots = atom.dots ?? 0;
  if (nDots > 0) {
    const dotAttachOpts = !atom.rest && keys.length > 1 ? ({ all: true } as const) : undefined;
    for (let i = 0; i < nDots; i++) {
      Dot.buildAndAttach([note], dotAttachOpts);
    }
  }
  return note;
}
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
 * 将一行内多小节渲染成图片（Canvas → data URL → <img>），
 * 小节 System 横向首尾相接。
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

  // 离屏 Canvas：VexFlow 以 Canvas 后端绘制，之后导出为 data URL
  const canvasId = `vf-canvas-${Math.random().toString(36).slice(2)}`;
  const canvas = document.createElement('canvas');
  canvas.id = canvasId;
  canvas.width = totalWidth;
  canvas.height = height;
  canvas.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px';
  host.appendChild(canvas);

  if (!hideOverlays) {
    for (let i = 0; i < n; i++) {
      const col = columns[i];
      const overlay = document.createElement('div');
      overlay.className = 'score-measure';
      overlay.dataset.measureIndex = String(col.measureIndex);
      overlay.dataset.hasStaffHeader = col.showStaffHeader ? '1' : '0';
      overlay.style.cssText = `position:absolute;left:${i * columnWidth}px;top:0;width:${columnWidth}px;height:100%;pointer-events:none`;
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

  container.appendChild(host);

  // --- VexFlow 绘制到 Canvas ---
  const factory = new Factory({
    renderer: { elementId: canvasId, width: totalWidth, height },
  });

  const noteMap = new Map<NoteKey, { note: import('vexflow').StaveNote; keyIdx: number }>();

  for (let i = 0; i < n; i++) {
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

    // 高音谱——捕获 StaveNote 引用
    const trebleVoice = factory.Voice({ time: vexVoiceTimeStr(ctx.timeSig) });
    trebleVoice.setMode(VoiceMode.SOFT);
    for (let ai = 0; ai < col.trebleAtoms.length; ai++) {
      const sn = atomToNote(factory, col.trebleAtoms[ai], 'treble');
      trebleVoice.addTickables([sn]);
      if (editState && !col.trebleAtoms[ai].rest) {
        for (let ki = 0; ki < sn.getKeys().length; ki++) {
          noteMap.set(`${col.measureIndex}:treble:${ai}:${ki}` as NoteKey, { note: sn, keyIdx: ki });
        }
      }
    }

    // 低音谱——捕获 StaveNote 引用
    const bassVoice = factory.Voice({ time: vexVoiceTimeStr(ctx.timeSig) });
    bassVoice.setMode(VoiceMode.SOFT);
    for (let ai = 0; ai < col.bassAtoms.length; ai++) {
      const sn = atomToNote(factory, col.bassAtoms[ai], 'bass');
      bassVoice.addTickables([sn]);
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

  // ── 编辑注解：符尾方向 / 连音线 / 连尾 / 指法 ──
  if (editState) {
    for (const [nk, dir] of editState.stemDirections) {
      const entry = noteMap.get(nk);
      if (entry) entry.note.setStemDirection(dir);
    }
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
    for (const tie of editState.ties) {
      const pf = tie.from.split(':'), pt = tie.to.split(':');
      if (pf[0] !== pt[0] || pf[1] !== pt[1]) continue;
      const sA = Math.min(Number(pf[2]), Number(pt[2]));
      const eA = Math.max(Number(pf[2]), Number(pt[2]));
      const seen = new Set<import('vexflow').StaveNote>();
      const beamNotes: import('vexflow').StaveNote[] = [];
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
    for (const [nk, finger] of editState.fingerNumbers) {
      const entry = noteMap.get(nk);
      if (entry) {
        const fing = factory.Fingering({ number: String(finger), position: 'above' });
        entry.note.addModifier(fing, entry.keyIdx);
      }
    }
  }

  // ── 选中音符高亮 ──
  if (selectedNoteKeys) {
    for (const nk of selectedNoteKeys) {
      const entry = noteMap.get(nk);
      if (entry) entry.note.setStyle({ fillStyle: '#e53935', strokeStyle: '#e53935' });
    }
  }

  factory.draw();

  // --- 导出 Canvas → PNG → <img> ---
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

  // 播放头 overlay
  for (let i = 0; i < n; i++) {
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

  container.appendChild(host);

  const factory = new Factory({
    renderer: { elementId: vfId, width: totalWidth, height },
  });

  // 收集行内所有 StaveNote → NoteKey 映射（连音 / 指法用）
  const noteMap = new Map<NoteKey, { note: import('vexflow').StaveNote; keyIdx: number }>();

  for (let i = 0; i < n; i++) {
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

    // 高音谱——捕获 StaveNote 引用
    const tAtoms = col.trebleAtoms;
    const trebleVoice = factory.Voice({ time: vexVoiceTimeStr(ctx.timeSig) });
    trebleVoice.setMode(VoiceMode.SOFT);
    const tNotes: import('vexflow').StaveNote[] = [];
    for (let ai = 0; ai < tAtoms.length; ai++) {
      const sn = atomToNote(factory, tAtoms[ai], 'treble');
      tNotes.push(sn);
      trebleVoice.addTickables([sn]);
      if (editState && !tAtoms[ai].rest) {
        for (let ki = 0; ki < sn.getKeys().length; ki++) {
          const nk = `${col.measureIndex}:treble:${ai}:${ki}` as NoteKey;
          noteMap.set(nk, { note: sn, keyIdx: ki });
        }
      }
    }

    // 低音谱
    const bAtoms = col.bassAtoms;
    const bassVoice = factory.Voice({ time: vexVoiceTimeStr(ctx.timeSig) });
    bassVoice.setMode(VoiceMode.SOFT);
    const bNotes: import('vexflow').StaveNote[] = [];
    for (let ai = 0; ai < bAtoms.length; ai++) {
      const sn = atomToNote(factory, bAtoms[ai], 'bass');
      bNotes.push(sn);
      bassVoice.addTickables([sn]);
      if (editState && !bAtoms[ai].rest) {
        for (let ki = 0; ki < sn.getKeys().length; ki++) {
          const nk = `${col.measureIndex}:bass:${ai}:${ki}` as NoteKey;
          noteMap.set(nk, { note: sn, keyIdx: ki });
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

  // ── 编辑注解：手指编号 ──
  if (editState) {
    for (const [nk, finger] of editState.fingerNumbers) {
      const entry = noteMap.get(nk);
      if (entry) {
        const fing = factory.Fingering({ number: String(finger), position: 'above' });
        entry.note.addModifier(fing, entry.keyIdx);
      }
    }
  }

  // ── 编辑注解：连音线 & 连尾（需要在 draw 前创建） ──
  if (editState) {
    // ── 符尾方向 ──
    for (const [nk, dir] of editState.stemDirections) {
      const entry = noteMap.get(nk);
      if (entry) {
        entry.note.setStemDirection(dir);
      }
    }

    // 连音线：用 StaveTie 绘制曲线
    for (const slur of editState.slurs) {
      const from = noteMap.get(slur.from);
      const to = noteMap.get(slur.to);
      if (from && to) {
        factory.StaveTie({
          from: from.note,
          to: to.note,
          firstIndexes: [from.keyIdx],
          lastIndexes: [to.keyIdx],
        });
      }
    }
    // 连尾：用 Beam 将符杆/符尾相连（包含中间所有音符）
    for (const tie of editState.ties) {
      const partsFrom = tie.from.split(':');
      const partsTo = tie.to.split(':');
      // 仅限同一小节、同一谱表
      if (partsFrom[0] !== partsTo[0] || partsFrom[1] !== partsTo[1]) continue;
      const startAtom = Math.min(Number(partsFrom[2]), Number(partsTo[2]));
      const endAtom = Math.max(Number(partsFrom[2]), Number(partsTo[2]));
      // 收集该范围内所有 StaveNote（去重，按 atom 顺序）
      const seen = new Set<import('vexflow').StaveNote>();
      const beamNotes: import('vexflow').StaveNote[] = [];
      for (let ai = startAtom; ai <= endAtom; ai++) {
        const prefix = `${partsFrom[0]}:${partsFrom[1]}:${ai}:`;
        for (const [nk, entry] of noteMap) {
          if (nk.startsWith(prefix) && !seen.has(entry.note)) {
            seen.add(entry.note);
            beamNotes.push(entry.note);
          }
        }
      }
      if (beamNotes.length >= 2) {
        factory.Beam({ notes: beamNotes });
      }
    }
  }

  // ── 选中音符高亮（支持多选） ──
  if (selectedNoteKeys) {
    for (const nk of selectedNoteKeys) {
      const entry = noteMap.get(nk);
      if (entry) {
        entry.note.setStyle({ fillStyle: '#e53935', strokeStyle: '#e53935' });
      }
    }
  }

  factory.draw();

  // ── 编辑模式下，为每个音符的符头(<g class="notehead">) 创建精确 hit area ──
  if (editState && selectedNoteKeys) {
    const hostRect = host.getBoundingClientRect();
    // 按 note 引用分组（一个 chord 共享一个 StaveNote，但有多把个符头）
    const byNote = new Map();
    for (const [nk, { note, keyIdx }] of noteMap) {
      const arr = byNote.get(note) ?? [];
      arr.push({ keyIdx, nk });
      byNote.set(note, arr);
    }
    for (const [note, entries] of byNote) {
      const rootEl = note.getSVGElement();
      if (!rootEl) continue;
      // 主 <g> 下的所有 <text> 按文档顺序 = keyIdx 顺序（符头 SMuFL 字形）
      const textEls = rootEl.querySelectorAll('text');
      for (const entry of entries) {
        const t = textEls[entry.keyIdx];
        if (!t) continue;
        const r = t.getBoundingClientRect();
        const hit = document.createElement('div');
        hit.className = 'note-hitarea';
        hit.dataset.noteKey = entry.nk;
        hit.style.cssText = `position:absolute;left:${r.left - hostRect.left}px;top:${r.top - hostRect.top}px;width:${r.width}px;height:${r.height}px;cursor:pointer;z-index:10;background:transparent`;
        host.appendChild(hit);
      }
    }
  }

  return height + 8;
}
