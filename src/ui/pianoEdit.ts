/**
 * 编辑模式和指法菜单功能（从 PianoPage 提取）
 */
import type { PianoPage } from './pianoPage';
import type { EditTool } from '../features/staffEditor';
import type { Track } from '@tonejs/midi';

/* ── 编辑模式 ── */

export function toggleEditMode(page: PianoPage): void {
  page.editModeActive = !page.editModeActive;
  syncEditModeUI(page);
  if (page.editModeActive) {
    page.stopPlayback();
    page.selectedNoteKeys.clear();
    page.renderAll();
  } else {
    page.selectedNoteKeys.clear();
  }
}

export function setEditTool(page: PianoPage, tool: EditTool, hint: string): void {
  page.editTool = tool;
  syncEditModeUI(page);
  page.keyboardHint.textContent = hint;
}

export function handleStemToggle(page: PianoPage): void {
  if (page.selectedNoteKeys.size === 0) return;
  let hasDown = false;
  for (const nk of page.selectedNoteKeys) {
    if (page.staffEditState.stemDirections.get(nk) === -1) { hasDown = true; break; }
  }
  const dir: 1 | -1 = hasDown ? 1 : -1;
  for (const nk of page.selectedNoteKeys) {
    page.staffEditState.stemDirections.set(nk, dir);
  }
  page.renderAll();
}

export async function saveEdits(page: PianoPage): Promise<void> {
  await saveToJson(page);
}

/** 保存指法到 JSON 文件（静默） */
export async function saveFingerEdits(page: PianoPage): Promise<void> {
  console.log('[saveFingerEdits] fingerNumbers size:', page.staffEditState.fingerNumbers.size);
  console.log('[saveFingerEdits] currentSongFile:', page.currentSongFile);
  console.log('[saveFingerEdits] currentSongName:', page.currentSongName);
  await saveToJson(page);
}

export async function saveToJson(page: PianoPage): Promise<void> {
  if (!page.currentSongFile || !page.currentMidi) {
    console.warn('[saveToJson] 跳过：currentSongFile=', page.currentSongFile, 'currentMidi=', !!page.currentMidi);
    return;
  }
  try {
    // 构建完整的 JSON（包含指法）
    const flatNotes = page.flatNotes;
    let fingerCount = 0;
    const notes = flatNotes.map(n => {
      const finger = n.noteKey ? page.staffEditState.fingerNumbers.get(n.noteKey) : undefined;
      if (finger) fingerCount++;
      return {
        midi: n.midi, time: n.time, duration: n.duration,
        ticks: n.ticks, durationTicks: n.durationTicks,
        trackIndex: n.trackIndex, vexKey: n.vexKey, velocity: n.velocity,
        ...(finger ? { finger } : {}),
      };
    });
    console.log('[saveToJson] flatNotes count:', flatNotes.length, '带指法的音符:', fingerCount);

    const data = {
      version: 1,
      name: page.currentSongName,
      duration: page.currentMidi.duration,
      durationTicks: page.currentMidi.durationTicks,
      header: {
        tempos: page.currentMidi.header.tempos.map(t => ({ bpm: t.bpm, ticks: t.ticks })),
        timeSignatures: page.currentMidi.header.timeSignatures.map(ts => ({
          ticks: ts.ticks, timeSignature: ts.timeSignature, measures: ts.measures,
        })),
        keySignatures: (page.currentMidi.header as { keySignatures?: Array<{ ticks: number; key: string; scale: string }> })
          .keySignatures?.map(ks => ({ ticks: ks.ticks, key: ks.key, scale: ks.scale })) ?? [],
        ppq: page.currentMidi.header.ppq,
      },
      trackCount: page.currentMidi.tracks.length,
      tracksWithNotes: page.currentMidi.tracks
        .map((t: Track, i: number) => (t.notes?.length > 0 ? i : -1))
        .filter((i: number) => i >= 0),
      notes,
      noteCount: notes.length,
      minMidi: notes.length > 0 ? Math.min(...notes.map(n => n.midi)) : 60,
      maxMidi: notes.length > 0 ? Math.max(...notes.map(n => n.midi)) : 84,
    };

    console.log('[saveToJson] 发送 POST, filename:', page.currentSongFile, 'notes:', notes.length);
    const resp = await fetch('/api/songs/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: page.currentSongFile, data }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    console.log('[saveToJson] 响应:', result);
    page.btnSaveEdits.textContent = '✓ 已保存';
    setTimeout(() => { page.btnSaveEdits.textContent = '保存'; }, 2000);
  } catch (e) {
    console.error('[saveToJson] error:', e);
    page.btnSaveEdits.textContent = '保存失败';
    setTimeout(() => { page.btnSaveEdits.textContent = '保存'; }, 3000);
  }
}

export function syncEditModeUI(page: PianoPage): void {
  const show = page.editModeActive;
  page.btnEdit.textContent = show ? '✓ 编辑' : '编辑';
  page.btnEdit.classList.toggle('primary', show);
  page.btnEdit.classList.toggle('secondary', !show);
  page.editToolbar.hidden = !show;
  page.btnFinger.classList.toggle('primary', page.editTool === 'select');
  page.btnFinger.classList.toggle('secondary', page.editTool !== 'select');
  page.btnSlur.classList.toggle('primary', page.editTool === 'slur');
  page.btnSlur.classList.toggle('secondary', page.editTool !== 'slur');
  page.btnTie.classList.toggle('primary', page.editTool === 'tie');
  page.btnTie.classList.toggle('secondary', page.editTool !== 'tie');
  if (!show) {
    page.keyboardHint.textContent = page.keyboardHint.textContent?.replace(/编辑.*?。/, '') ?? '';
  }
}

export function handleEditKeydown(page: PianoPage, e: KeyboardEvent): void {
  if (!page.editModeActive || page.selectedNoteKeys.size === 0 || page.getPlayMode() === 'auto') return;
  if (e.repeat) return;
  if (e.key >= '1' && e.key <= '5') {
    e.preventDefault();
    for (const nk of page.selectedNoteKeys) page.staffEditState.fingerNumbers.set(nk, Number(e.key));
    page.buildFingerMapFromEditState();
    page.syncFingerMapToFallingNotes();
    page.renderAll();
    void saveFingerEdits(page);
  } else if (e.key === '0' || e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    for (const nk of page.selectedNoteKeys) {
      page.staffEditState.fingerNumbers.delete(nk);
      page.staffEditState.slurs = page.staffEditState.slurs.filter(s => s.from !== nk && s.to !== nk);
      page.staffEditState.ties = page.staffEditState.ties.filter(t => t.from !== nk && t.to !== nk);
      page.staffEditState.stemDirections.delete(nk);
    }
    page.buildFingerMapFromEditState();
    page.syncFingerMapToFallingNotes();
    page.selectedNoteKeys.clear();
    page.renderAll();
  }
}

export function handleScoreMouseDown(page: PianoPage, e: MouseEvent): void {
  // 仅左键，仅编辑模式，仅 original 渲染
  if (e.button !== 0 || !page.editModeActive || page.getRenderMode() !== 'original') return;

  const hit = (e.target as HTMLElement).closest<HTMLElement>('.note-hitarea');
  if (hit?.dataset.noteKey) {
    const nk = hit.dataset.noteKey;

    // 指法工具：左键弹出指法菜单
    if (page.editTool === 'select') {
      console.log('[handleScoreMouseDown] select tool, calling handleScoreNoteClick nk:', nk);
      handleScoreNoteClick(page, nk, hit);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // slur / tie 工具：保持原有选择逻辑
    if (page.editTool === 'slur' || page.editTool === 'tie') {
      if (e.shiftKey) {
        if (page.selectedNoteKeys.has(nk)) page.selectedNoteKeys.delete(nk);
        else page.selectedNoteKeys.add(nk);
      } else {
        page.selectedNoteKeys.clear();
        page.selectedNoteKeys.add(nk);
      }
      if (page.selectedNoteKeys.size === 2) {
        const [a, b] = [...page.selectedNoteKeys];
        if (page.editTool === 'slur') page.staffEditState.slurs.push({ from: a, to: b });
        else if (page.editTool === 'tie') page.staffEditState.ties.push({ from: a, to: b });
        page.selectedNoteKeys.clear();
      }
      page.renderAll();
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // 框选
  page.selectedNoteKeys.clear();
  page.renderAll();
  const rect = page.scoreScrollEl.getBoundingClientRect();
  page.selDragStart = { x: e.clientX - rect.left + page.scoreScrollEl.scrollLeft, y: e.clientY - rect.top + page.scoreScrollEl.scrollTop };
  const sel = ensureSelRect(page);
  sel.style.display = 'block';
  sel.style.left = `${page.selDragStart.x}px`;
  sel.style.top = `${page.selDragStart.y}px`;
  sel.style.width = '0';
  sel.style.height = '0';
}

export function handleScoreMouseMove(page: PianoPage, e: MouseEvent): void {
  if (!page.selDragStart || !page.selRectEl) return;
  e.preventDefault();
  const rect = page.scoreScrollEl.getBoundingClientRect();
  const curX = e.clientX - rect.left + page.scoreScrollEl.scrollLeft;
  const curY = e.clientY - rect.top + page.scoreScrollEl.scrollTop;
  const l = Math.min(page.selDragStart.x, curX);
  const t = Math.min(page.selDragStart.y, curY);
  const w = Math.abs(curX - page.selDragStart.x);
  const h = Math.abs(curY - page.selDragStart.y);
  page.selRectEl.style.left = `${l}px`;
  page.selRectEl.style.top = `${t}px`;
  page.selRectEl.style.width = `${w}px`;
  page.selRectEl.style.height = `${h}px`;
}

export function handleScoreMouseUp(page: PianoPage): void {
  if (!page.selDragStart || !page.selRectEl) return;
  if (page.selRectEl.style.display === 'none') { page.selDragStart = null; return; }
  const rect = page.selRectEl.getBoundingClientRect();
  const hits = page.scoreScrollEl.querySelectorAll<HTMLElement>('.note-hitarea');
  page.selectedNoteKeys.clear();
  for (const h of hits) {
    const hRect = h.getBoundingClientRect();
    if (hRect.right > rect.left && hRect.left < rect.right &&
        hRect.bottom > rect.top && hRect.top < rect.bottom) {
      if (h.dataset.noteKey) page.selectedNoteKeys.add(h.dataset.noteKey);
    }
  }
  removeSelRect(page);
  page.selDragStart = null;
  page.renderAll();
}

export function ensureSelRect(page: PianoPage): HTMLDivElement {
  if (!page.selRectEl) {
    page.selRectEl = document.createElement('div');
    page.selRectEl.className = 'sel-rect';
    page.scoreScrollEl.appendChild(page.selRectEl);
  }
  return page.selRectEl;
}

export function removeSelRect(page: PianoPage): void {
  if (page.selRectEl) { page.selRectEl.style.display = 'none'; page.selRectEl.style.width = '0'; page.selRectEl.style.height = '0'; }
}

/* ── 指法菜单 ── */

export function createFingerMenu(page: PianoPage): HTMLDivElement {
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
    if (!btn || !page.fingerMenuNoteKey) return;
    e.preventDefault();
    e.stopPropagation();
    const finger = Number(btn.dataset.finger);
    const nk = page.fingerMenuNoteKey;
    console.log('[finger-menu] click finger:', finger, 'noteKey:', nk);

    if (nk.startsWith('_falling:')) {
      // 下落音符无精确 NoteKey，忽略
      page.syncFingerMapToFallingNotes();
    } else {
      // 五线谱音符：更新 NoteKey → 手指映射
      if (finger === 0) {
        page.staffEditState.fingerNumbers.delete(nk);
      } else {
        page.staffEditState.fingerNumbers.set(nk, finger);
      }
      page.syncFingerMapToFallingNotes();
    }

    // 播放下不重绘乐谱
    if (!page.playback?.isPlaying()) {
      page.renderAll();
    }
    hideFingerMenu(page);
    saveFingerEdits(page);
  });
  document.body.appendChild(menu);
  return menu;
}

export function handleScoreContextMenu(page: PianoPage, e: MouseEvent): void {
  console.log('[handleScoreContextMenu] renderMode:', page.getRenderMode(), 'editModeActive:', page.editModeActive);
  if (page.getRenderMode() !== 'original') return;
  hideFingerMenu(page);

  const hit = (e.target as HTMLElement).closest<HTMLElement>('.note-hitarea');
  if (!hit || !hit.dataset.noteKey) return;

  e.preventDefault();
  e.stopPropagation();

  page.fingerMenuNoteKey = hit.dataset.noteKey;

  const menu = page.fingerMenuEl;
  menu.hidden = false;
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  const currentFinger = page.staffEditState.fingerNumbers.get(page.fingerMenuNoteKey);
  menu.querySelectorAll<HTMLButtonElement>('.finger-menu-btn').forEach(b => {
    const f = Number(b.dataset.finger);
    b.classList.toggle('finger-menu-btn--active', f === currentFinger);
  });
}

/** 五线谱音符左键点击 → 弹出指法菜单 */
export function handleScoreNoteClick(page: PianoPage, nk: string, hit: HTMLElement): void {
  console.log('[handleScoreNoteClick] nk:', nk);
  hideFingerMenu(page);
  page.fingerMenuNoteKey = nk;

  const rect = hit.getBoundingClientRect();
  const menu = page.fingerMenuEl;
  menu.hidden = false;
  menu.style.left = `${rect.left + rect.width / 2}px`;
  menu.style.top = `${rect.top}px`;

  const currentFinger = page.staffEditState.fingerNumbers.get(nk);
  menu.querySelectorAll<HTMLButtonElement>('.finger-menu-btn').forEach(b => {
    const f = Number(b.dataset.finger);
    b.classList.toggle('finger-menu-btn--active', f === currentFinger);
  });
}

export function hideFingerMenu(page: PianoPage): void {
  page.fingerMenuEl.hidden = true;
  page.fingerMenuNoteKey = null;
}

/** 下落音符点击 */
export function handleFallingNoteClick(page: PianoPage, noteKey: string | null, midi: number): void {
  const nk = noteKey ?? `_falling:${midi}`;

  hideFingerMenu(page);
  page.fingerMenuNoteKey = nk;

  const menu = page.fingerMenuEl;
  menu.hidden = false;
  menu.style.left = `${Math.min(window.innerWidth - 120, Math.max(60, window.innerWidth / 2))}px`;
  menu.style.top = `${window.innerHeight / 2}px`;

  let currentFinger: number | undefined;
  if (noteKey) {
    currentFinger = page.staffEditState.fingerNumbers.get(noteKey);
  }
  menu.querySelectorAll<HTMLButtonElement>('.finger-menu-btn').forEach(b => {
    const f = Number(b.dataset.finger);
    b.classList.toggle('finger-menu-btn--active', f === currentFinger);
  });
}
