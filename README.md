# 🎹 Melodia Piano

> 旋律为名，指尖为谱。

Melodia Piano 是一个基于 Web 的 **MIDI 钢琴乐谱展示与钢琴练习工具**，专注于钢琴演奏练习：支持五线谱渲染、瀑布流演奏、MIDI 键盘接入和实时评分。

## 关于名字

**Melodia** 取自意大利语 / 拉丁语中的「旋律」（melodia），后缀 **Piano** 明确指向钢琴这一核心乐器。

- 简短、易读、易记，便于作为项目名与域名使用
- `Melodia` 呼应「乐谱 + 演奏」，`Piano` 强调这是**钢琴专属**练习工具，而非通用 MIDI 播放器
- 不含 `my_` 之类临时前缀，更适合长期演进与开源发布

## 功能特性

- **钢琴键盘可视化** — 88 键钢琴键盘，实时高亮对应琴键，支持指法标注
- **钢琴指法分配** — 自动为音符分配左右手与指法，并可手动编辑
- **五线谱渲染** — 基于 [VexFlow](https://www.vexflow.com/) 渲染标准钢琴大谱表，支持翻页浏览
- **瀑布流（下落式）模式** — 类似节奏游戏的音符下落玩法，贴合钢琴弹奏
- **MIDI 键盘接入** — 通过 Web MIDI API 连接外部 MIDI 钢琴键盘进行演奏练习
- **实时评分系统** — 根据按键准确度给出 Perfect / OK / Bad / Miss 判定，支持连击统计
- **和弦检测** — 自动识别并显示当前演奏和弦名称
- **钢琴谱编辑** — 支持指法、连奏线（slur）、延音线（tie）、符干方向的手动编辑
- **钢琴音源播放** — 内置 Salamander Piano 音源，无需额外安装
- **练习历史** — 记录每次钢琴练习的得分、准确率、最大连击等数据
- **结果可视化** — 演奏结束后展示 Timing 分布图和成绩详情

## 技术栈

| 类别         | 技术                                        |
| ------------ | ------------------------------------------- |
| 框架         | TypeScript + Vite                           |
| 钢琴谱渲染   | VexFlow 5                                   |
| MIDI 解析    | @tonejs/midi                                |
| 钢琴音源     | Salamander Piano (SoundFont)                |
| MIDI 输入    | Web MIDI API                                |

## 项目结构

```
melodia-piano/
├── public/
│   ├── songs/           # MIDI 转换后的钢琴曲 JSON 文件
│   ├── soundfont/       # 钢琴音源采样文件
│   └── js/              # 第三方 JS 库
├── scripts/             # 工具脚本
│   ├── midi-to-json.mjs         # MIDI → JSON 转换
│   ├── calculate-difficulty.mjs # 难度计算
│   ├── generate-demo-midi.mjs   # 生成演示 MIDI
│   ├── download-samples.mjs     # 下载钢琴音源采样
│   ├── simulate-midi.ts         # MIDI 模拟测试
│   └── trim-first-2-bars.mjs    # 裁剪前两小节
├── src/
│   ├── core/            # 核心逻辑（和弦检测、钢琴指法分配、评分、MIDI 匹配等）
│   ├── features/        # 功能模块（钢琴练习、播放、编辑、演示）
│   ├── rendering/       # 渲染层（钢琴大谱表、键盘、下落音符）
│   ├── ui/              # UI 组件（设置、历史、结果页等）
│   ├── audio/           # 钢琴音频引擎
│   ├── main.ts          # 主入口
│   └── style.css        # 全局样式
├── logs/                # 演奏日志输出目录
└── dist/                # 构建输出
```

## 快速开始

### 环境要求

- Node.js >= 18

### 安装与运行

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

浏览器访问 `http://localhost:5173` 即可使用。

### 添加钢琴曲

1. 将 `.mid` 文件放入 `public/songs/` 目录
2. 运行转换脚本：
   ```bash
   npm run midi-to-json
   ```
3. 刷新页面，钢琴曲将出现在列表中

### 其他命令

| 命令                      | 说明                   |
| ------------------------- | ---------------------- |
| `npm run build`           | 生产构建               |
| `npm run preview`         | 预览生产构建           |
| `npm run midi-to-json`    | MIDI 文件转 JSON       |
| `npm run calc-difficulty` | 计算歌曲难度等级       |
| `npm run download-samples`| 下载音源采样文件       |
| `npm run generate-demo`   | 生成演示 MIDI 文件     |
| `npm run simulate`        | MIDI 模拟测试          |

## 设置项

- **下落速度** — 调整瀑布流模式的下落速度
- **播放速度** — 调整整体播放速度（0.5x ~ 2.0x）
- **小节宽度** — 调整钢琴谱每小节的渲染宽度
- **和弦语言** — 切换和弦显示语言（英文 / 中文）
- **偏移调整** — 修正 MIDI 钢琴键盘的输入延迟
- **难度筛选** — 按难度等级过滤歌曲列表

## 许可

仅供学习与个人使用。

---

<p align="center">Made with 🎹 &nbsp;·&nbsp; Melodia Piano &nbsp;·&nbsp; 为钢琴而生</p>
