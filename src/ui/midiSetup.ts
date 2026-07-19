/**
 * MIDI 设备管理：检测、选择、状态显示
 */

export interface MidiDeviceElements {
  pianoSelect: HTMLSelectElement;
  pianoRefresh: HTMLButtonElement;
  songListSelect: HTMLSelectElement;
  songListRefresh: HTMLButtonElement;
  songListStatus: HTMLSpanElement;
}

export class MidiSetup {
  private midiAccess: MIDIAccess | null = null;
  private elements: MidiDeviceElements;

  constructor(elements: MidiDeviceElements) {
    this.elements = elements;
  }

  async ensureAccess(): Promise<MIDIAccess | null> {
    if (!navigator.requestMIDIAccess) return null;
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      this.midiAccess = access;
      access.onstatechange = () => this.refillSelects();
      return access;
    } catch {
      return null;
    }
  }

  getAccess(): MIDIAccess | null {
    return this.midiAccess;
  }

  getSelectedInput(): MIDIInput | null {
    if (!this.midiAccess) return null;
    const id = this.elements.pianoSelect.value;
    if (id) {
      const input = this.midiAccess.inputs.get(id);
      if (input) return input;
    }
    const first = [...this.midiAccess.inputs.values()][0];
    return first ?? null;
  }

  refillSelects(): void {
    this.fillSelect(this.elements.pianoSelect, this.elements.pianoSelect.value);
    this.syncSongListSelect();
  }

  private fillSelect(sel: HTMLSelectElement, prevValue: string): void {
    sel.innerHTML = '';
    if (!this.midiAccess) return;
    this.midiAccess.inputs.forEach((input) => {
      const opt = document.createElement('option');
      opt.value = input.id;
      opt.textContent = input.name || input.id || 'MIDI 输入';
      sel.appendChild(opt);
    });
    if (prevValue && [...sel.options].some(o => o.value === prevValue)) {
      sel.value = prevValue;
    }
  }

  private syncSongListSelect(): void {
    const songSel = this.elements.songListSelect;
    const pianoSel = this.elements.pianoSelect;
    const prev = songSel.value;
    songSel.innerHTML = '';
    if (!this.midiAccess) return;
    this.midiAccess.inputs.forEach((input) => {
      const opt = document.createElement('option');
      opt.value = input.id;
      opt.textContent = input.name || input.id || 'MIDI 输入';
      songSel.appendChild(opt);
    });
    const restoreValue = prev && [...songSel.options].some(o => o.value === prev) ? prev : pianoSel.value;
    if (restoreValue && [...songSel.options].some(o => o.value === restoreValue)) {
      songSel.value = restoreValue;
    }
    this.updateSongListStatus();
  }

  updateSongListStatus(): void {
    const el = this.elements.songListStatus;
    if (!this.midiAccess) {
      el.textContent = '浏览器不支持 MIDI';
      el.className = 'song-list-midi-status song-list-midi-status--none';
      return;
    }
    const sel = this.elements.songListSelect;
    if (sel.value && sel.selectedOptions[0]) {
      el.textContent = `已连接: ${sel.selectedOptions[0].textContent}`;
      el.className = 'song-list-midi-status song-list-midi-status--ok';
    } else if (this.midiAccess.inputs.size === 0) {
      el.textContent = '未检测到设备';
      el.className = 'song-list-midi-status song-list-midi-status--none';
    } else {
      el.textContent = `${this.midiAccess.inputs.size} 个设备可用`;
      el.className = 'song-list-midi-status song-list-midi-status--ok';
    }
  }
}
