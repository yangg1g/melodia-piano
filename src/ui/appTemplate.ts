export const appTemplate = `
  <div id="song-list-page" class="page">
    <header class="song-list-header">
      <div class="song-list-header-row">
        <h1 class="song-list-title">🎹 MIDI Piano</h1>
        <button type="button" id="settings-btn" class="btn secondary settings-header-btn">⚙</button>
      </div>
      <p class="song-list-subtitle">选择一首歌曲开始练习</p>
      <div id="settings-summary" class="settings-summary">普通 · 下落 3.0s · 速度 1.0× · 普通判定</div>
      <div id="song-list-midi-row" class="song-list-midi-row">
        <label class="song-list-midi-label" for="song-list-midi-input">MIDI 输入</label>
        <select id="song-list-midi-input" class="song-list-midi-select" aria-label="MIDI 输入设备"></select>
        <button type="button" id="song-list-midi-refresh" class="btn secondary song-list-midi-btn">刷新设备</button>
        <span id="song-list-midi-status" class="song-list-midi-status"></span>
      </div>
    </header>
    <div class="song-list-body">
      <div class="history-panel">
        <div class="history-panel-header"><h3 class="history-panel-title">历史成绩</h3></div>
        <div id="history-list" class="history-list"><div class="history-empty">选择歌曲后显示历史成绩</div></div>
      </div>
      <div class="song-list-column">
        <div id="song-list" class="song-list" tabindex="0"><div class="song-list-loading">加载中…</div></div>
        <div class="song-list-actions">
          <button type="button" id="btn-song-practice" class="btn primary" disabled>🎹 练习模式</button>
          <label class="file-btn file-btn--local">
            打开本地 MIDI 文件
            <input type="file" id="midi-file" accept=".mid,.midi,audio/midi" hidden />
          </label>
        </div>
      </div>
    </div>
  </div>

  <div id="piano-page" class="page" hidden>
    <header class="toolbar">
      <h1 class="title">MIDI 乐谱</h1>
      <span id="measure-info" class="measure-info"></span>
      <div class="toolbar-actions">
        <button type="button" id="btn-back" class="btn secondary">← 返回</button>
        <button type="button" id="btn-play" class="btn primary">播放</button>
        <button type="button" id="btn-stop" class="btn secondary" disabled>停止</button>
        <button type="button" id="btn-edit" class="btn secondary" hidden>编辑</button>
        <button type="button" id="btn-download-log" class="btn secondary" title="下载按键日志">📥 日志</button>
        <select id="midi-input" hidden aria-label="MIDI 输入设备"></select>
        <button id="btn-midi-refresh" hidden></button>
      </div>
      <div class="edit-toolbar" hidden>
        <button type="button" id="btn-finger" class="btn secondary">指法</button>
        <button type="button" id="btn-slur" class="btn secondary">连音</button>
        <button type="button" id="btn-tie" class="btn secondary">连尾</button>
        <button type="button" id="btn-stem" class="btn secondary">符尾方向</button>
        <button type="button" id="btn-save-edits" class="btn secondary">保存</button>
      </div>
    </header>
    <div class="progress-bar-wrap">
      <input type="range" id="progress-bar" class="progress-bar" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
      <span id="progress-time" class="progress-time">0:00 / 0:00</span>
      <span id="practice-time" class="practice-time" hidden></span>
    </div>
    <div id="practice-controls-bar" class="practice-controls-bar" hidden>
      <div class="practice-measure-range">
        <span>循环小节</span>
        <button type="button" id="practice-start-dec" class="btn secondary practice-btn-sm">◀</button>
        <input type="number" class="practice-measure-input" id="practice-start-label" value="1" min="1" step="1" />
        <button type="button" id="practice-start-inc" class="btn secondary practice-btn-sm">▶</button>
        <span>–</span>
        <button type="button" id="practice-end-dec" class="btn secondary practice-btn-sm">◀</button>
        <input type="number" class="practice-measure-input" id="practice-end-label" value="1" min="1" step="1" />
        <button type="button" id="practice-end-inc" class="btn secondary practice-btn-sm">▶</button>
      </div>
      <div class="practice-loop-info">
        <span class="practice-loop-counter" id="practice-loop-counter">第 1 轮</span>
        <span class="practice-loop-best" id="practice-loop-best"></span>
      </div>
      <div class="practice-group-size">
        <span class="practice-group-size-label">合并小节</span>
        <input type="number" class="practice-measure-input" id="practice-group-size-input" value="1" min="1" max="50" step="1" />
      </div>
    </div>
    <div class="piano-content">
      <div id="practice-left-panel" class="practice-left-panel" hidden>
        <div class="practice-left-panel-header">错误分析</div>
        <div id="practice-left-content" class="practice-left-content"></div>
      </div>
      <div id="live-accuracy-panel" class="live-accuracy-panel" hidden>
        <div class="live-accuracy-panel-header">实时图表</div>
        <div class="live-chart-section">
          <div class="live-chart-title">错误时间线</div>
          <canvas id="live-timeline-canvas" class="live-accuracy-canvas"></canvas>
        </div>
        <div class="live-chart-section">
          <div class="live-chart-title">按键偏差</div>
          <canvas id="live-error-canvas" class="live-accuracy-canvas"></canvas>
        </div>
        <div class="live-chart-section">
          <div class="live-chart-title">实时准度</div>
          <canvas id="live-accuracy-canvas" class="live-accuracy-canvas"></canvas>
        </div>
        <div class="live-chart-section" id="live-time-ratio-section" hidden>
          <div class="live-chart-title">用时占比</div>
          <canvas id="live-time-ratio-canvas" class="live-accuracy-canvas"></canvas>
        </div>
      </div>
      <main class="main">
        <div id="score-scroll" class="score-scroll">
          <div id="score-pager" class="score-pager" hidden>
            <button type="button" id="score-prev" class="btn secondary">上一页</button>
            <span id="score-page-info" class="score-page-info"></span>
            <button type="button" id="score-next" class="btn secondary">下一页</button>
          </div>
          <div id="score" class="score"></div>
        </div>
        <section class="keyboard-section">
          <p class="hint" id="keyboard-hint"></p>
          <div id="keyboard-stack" class="keyboard-stack">
            <div id="keyboard-host"></div>
            <div id="center-judge" class="center-judge"></div>
          </div>
        </section>
      </main>
      <div id="right-side-panel" class="right-side-panel">
        <div id="score-side-panel" class="score-side-panel" hidden>
          <div class="score-side-panel-header">成绩</div>
          <div id="score-display" class="score-display score-display--side">
            <span class="score-display-score" id="score-value">0</span>
            <span class="score-display-accu" id="score-accu">100.00%</span>
            <span class="score-display-combo" id="score-combo"></span>
            <span class="score-display-judge" id="score-judge"></span>
            <span class="score-display-wrong" id="score-wrong"></span>
          </div>
        </div>
        <div id="practice-side-panel" class="practice-side-panel" hidden>
          <div class="practice-side-panel-header" id="practice-side-header">练习记录</div>
          <div id="practice-side-scores" class="practice-side-scores"></div>
        </div>
        <div id="chord-side-panel" class="chord-side-panel" hidden>
          <div class="chord-side-panel-header">和弦</div>
          <div id="chord-display" class="chord-display">
            <span class="chord-display-notes" id="chord-display-notes"></span>
            <span class="chord-display-chord" id="chord-display-chord"></span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="result-page" class="page" hidden>
    <div class="result-card">
      <div class="result-title">结算</div>
      <div class="result-header">
        <div class="result-score" id="result-score">0</div>
        <div class="result-max-score" id="result-max-score">理论最高 0</div>
      </div>
      <div class="result-sub-row">
        <span class="result-accuracy" id="result-accuracy">100.00%</span>
      </div>
      <div class="result-sub-row">
        <span class="result-score-label">Max Combo</span>
        <span class="result-maxcombo" id="result-maxcombo">0</span>
      </div>
      <div class="result-timing-section" id="result-timing-section" hidden>
        <div class="result-timing-title">用时统计（跟弹模式）</div>
        <div class="result-timing-row"><span class="result-timing-label">原曲时长</span><span class="result-timing-value" id="result-timing-original">0:00</span></div>
        <div class="result-timing-row"><span class="result-timing-label">实际用时</span><span class="result-timing-value" id="result-timing-actual">0:00</span></div>
        <div class="result-timing-row result-timing-row--highlight"><span class="result-timing-label">用时占比</span><span class="result-timing-value" id="result-timing-slower">0%</span></div>
      </div>
      <div class="result-judgements">
        <div class="result-judge-row"><span class="judge-label judge--perfect">PERFECT</span><span class="judge-count" id="judge-perfect">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--ok">OK</span><span class="judge-count" id="judge-ok">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--bad">BAD</span><span class="judge-count" id="judge-bad">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--miss">MISS</span><span class="judge-count" id="judge-miss">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--wrong">WRONG</span><span class="judge-count" id="judge-wrong">0</span></div>
      </div>
      <div class="result-chart-legend">
        <span class="detail-legend-item"><span class="detail-dot detail-dot--perfect"></span> PERFECT</span>
        <span class="detail-legend-item"><span class="detail-dot detail-dot--ok"></span> OK</span>
        <span class="detail-legend-item"><span class="detail-dot detail-dot--bad"></span> BAD</span>
        <span class="detail-legend-item"><span class="detail-dot detail-dot--miss"></span> MISS</span>
        <span class="detail-legend-item"><span class="detail-dot detail-dot--wrong"></span> WRONG</span>
      </div>
      <div class="result-chart-wrap"><canvas id="result-chart-canvas" class="result-chart-canvas"></canvas></div>
      <div class="result-error-section">
        <div class="result-error-header"><span class="result-error-title">按键偏差曲线</span><span class="result-error-avg" id="result-avg-error">平均偏差 0.0ms</span></div>
        <div class="result-chart-wrap"><canvas id="result-error-curve-canvas" class="result-chart-canvas"></canvas></div>
      </div>
      <div class="result-error-section">
        <div class="result-error-header"><span class="result-error-title">实时准度曲线</span><span class="result-error-avg" id="result-accuracy-curve-info"></span></div>
        <div class="result-chart-wrap"><canvas id="result-accuracy-curve-canvas" class="result-chart-canvas"></canvas></div>
      </div>
      <div class="result-error-section" id="result-time-ratio-section" hidden>
        <div class="result-error-header"><span class="result-error-title">用时占比曲线</span><span class="result-error-avg" id="result-time-ratio-info"></span></div>
        <div class="result-chart-wrap"><canvas id="result-time-ratio-canvas" class="result-chart-canvas"></canvas></div>
      </div>
      <div class="result-buttons">
        <button type="button" id="result-replay-btn" class="btn secondary result-replay-btn" hidden>回放</button>
        <button type="button" id="result-back-btn" class="btn primary result-back-btn">返回选歌</button>
      </div>
    </div>
  </div>

  <div id="settings-page" class="page" hidden>
    <div class="settings-card">
      <div class="settings-header">
        <h2 class="settings-title">设置</h2>
        <button type="button" id="settings-back-btn" class="btn secondary">← 返回</button>
      </div>
      <div class="settings-body">
        <div class="settings-group">
          <label class="settings-label">默认模式</label>
          <div class="settings-mode-group">
            <label><input type="radio" name="settings-mode" value="normal" checked /> 普通模式</label>
            <label><input type="radio" name="settings-mode" value="auto" /> 自动播放</label>
            <label><input type="radio" name="settings-mode" value="keyboard" /> MIDI 跟弹</label>
          </div>
        </div>
        <div class="settings-group">
          <label class="settings-label">五线谱渲染方式</label>
          <div class="settings-mode-group">
            <label><input type="radio" name="settings-render" value="image" checked /> 图片滚动</label>
            <label><input type="radio" name="settings-render" value="original" /> 原始五线谱</label>
          </div>
        </div>
        <div class="settings-group">
          <label class="settings-label" for="settings-falling-speed">下落速度</label>
          <div class="settings-slider-row">
            <span>快</span><input type="range" id="settings-falling-speed" min="0.5" max="6" step="0.5" value="3" /><span>慢</span>
            <span class="settings-value" id="settings-falling-speed-val">3.0s</span>
          </div>
        </div>
        <div class="settings-group">
          <label class="settings-label" for="settings-playback-speed">播放速度</label>
          <div class="settings-slider-row">
            <span>0.5×</span><input type="range" id="settings-playback-speed" min="0.5" max="2" step="0.1" value="1" /><span>2.0×</span>
            <span class="settings-value" id="settings-playback-speed-val">1.0×</span>
          </div>
        </div>
        <div class="settings-group">
          <label class="settings-label" for="settings-measure-width">小节宽度</label>
          <div class="settings-slider-row">
            <span>100</span><input type="range" id="settings-measure-width" min="100" max="400" step="10" value="180" /><span>400</span>
            <span class="settings-value" id="settings-measure-width-val">180px</span>
          </div>
        </div>
        <div class="settings-group">
          <label class="settings-label">判定难度</label>
          <div class="settings-difficulty-group">
            <label><input type="radio" name="settings-difficulty" value="easy" /> 宽松</label>
            <label><input type="radio" name="settings-difficulty" value="normal" checked /> 普通</label>
            <label><input type="radio" name="settings-difficulty" value="hard" /> 严格</label>
          </div>
          <div class="settings-difficulty-info" id="settings-difficulty-info">PERFECT ≤ 25ms · OK ≤ 180ms · BAD ≤ 260ms</div>
        </div>
        <div class="settings-group">
          <label class="settings-label" for="settings-offset-adjust">判定偏移补偿</label>
          <div class="settings-slider-row">
            <span>-200ms</span><input type="range" id="settings-offset-adjust" min="-200" max="200" step="5" value="0" /><span>+200ms</span>
            <span class="settings-value" id="settings-offset-adjust-val">0ms</span>
          </div>
          <div class="settings-hint">正向 = 补偿按晚，负向 = 补偿按早</div>
        </div>
        <div class="settings-group">
          <label class="settings-label">和弦显示语言</label>
          <div class="settings-mode-group">
            <label><input type="radio" name="settings-chord-lang" value="zh" checked /> 中文</label>
            <label><input type="radio" name="settings-chord-lang" value="en" /> 英文</label>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="confirm-dialog" class="confirm-dialog" hidden>
    <div class="confirm-dialog-card">
      <p id="confirm-dialog-msg" class="confirm-dialog-msg"></p>
      <div class="confirm-dialog-actions">
        <button type="button" id="confirm-dialog-cancel" class="btn secondary">取消</button>
        <button type="button" id="confirm-dialog-ok" class="btn primary" style="background:var(--accent);color:#fff;">确定</button>
      </div>
    </div>
  </div>
`;
