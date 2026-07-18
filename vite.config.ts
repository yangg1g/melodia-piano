import { defineConfig } from 'vite';
import { readdirSync, existsSync, appendFileSync, mkdirSync } from 'fs';
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
        const songsDir = resolve(process.cwd(), 'public', 'songs');

        server.middlewares.use('/api/songs', (_req, res) => {
          try {
            const files: string[] = [];
            if (existsSync(songsDir)) {
              for (const f of readdirSync(songsDir)) {
                const ext = f.toLowerCase();
                if (ext.endsWith('.mid') || ext.endsWith('.midi')) {
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
