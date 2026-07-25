import { defineConfig } from 'vite';
import { readdirSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

const LOG_DIR = resolve(process.cwd(), 'logs');

export default defineConfig({
  plugins: [
    {
      name: 'midi-logger',
      configureServer(server) {
        // 确保日志目录存在
        if (!existsSync(LOG_DIR)) {
          mkdirSync(LOG_DIR, { recursive: true });
        }

        let currentLogFile = '';

        function getLogFilePath(): string {
          if (!currentLogFile) {
            const now = new Date();
            const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
            currentLogFile = join(LOG_DIR, `midi-log_${ts}.txt`);
          }
          return currentLogFile;
        }

        // 接收日志行并实时追加到文件
        server.middlewares.use('/api/log', (req, res) => {
          if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
              try {
                const filePath = getLogFilePath();
                appendFileSync(filePath, body + '\n', 'utf-8');
                res.statusCode = 200;
                res.end('ok');
              } catch (e) {
                console.error('[midi-logger] 写入失败:', e);
                res.statusCode = 500;
                res.end('error');
              }
            });
            return;
          }
          res.statusCode = 405;
          res.end('method not allowed');
        });

        // 开始新弹奏 → 创建新日志文件
        server.middlewares.use('/api/log/new', (req, res) => {
          if (req.method === 'POST') {
            currentLogFile = '';
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ path: getLogFilePath() }));
            return;
          }
          res.statusCode = 405;
          res.end('method not allowed');
        });

        // 获取当前日志文件路径
        server.middlewares.use('/api/log/file', (_req, res) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ path: getLogFilePath() }));
        });
      },
    },
    {
      name: 'song-list',
      configureServer(server) {
        const songsDir = resolve(process.cwd(), 'public', 'songs', 'json');

        // 保存歌曲 JSON（指法编辑等）—— 必须在 /api/songs 之前注册，
        // 否则 /api/songs 前缀匹配会拦截此路由且不调用 next()
        server.middlewares.use('/api/songs/save', (req, res) => {
          console.log('[server] /api/songs/save 收到请求, method:', req.method);
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end('method not allowed');
            return;
          }
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              const { filename, data } = JSON.parse(body);
              const fingerNotes = data.notes?.filter((n: any) => n.finger)?.length ?? 0;
              console.log('[server] save filename:', filename, 'total notes:', data.notes?.length, 'with finger:', fingerNotes);
              const jsonDir = songsDir;
              if (!existsSync(jsonDir)) mkdirSync(jsonDir, { recursive: true });
              const jsonPath = join(jsonDir, filename);
              writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
              console.log('[server] 写入完成:', jsonPath);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true }));
            } catch (e) {
              console.error('[song-save] error:', e);
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: String(e) }));
            }
          });
        });

        server.middlewares.use('/api/songs', (req, res) => {
          console.log('[server] /api/songs 收到请求, method:', req.method, 'url:', req.url);
          try {
            const files: string[] = [];
            if (existsSync(songsDir)) {
              for (const f of readdirSync(songsDir)) {
                if (f.endsWith('.json')) {
                  files.push(f);
                }
              }
            }
            files.sort();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(files));
          } catch {
            res.statusCode = 500;
            res.end('[]');
          }
        });
      },
    },
  ],
});
