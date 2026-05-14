import { defineConfig } from 'vite';
import { readdirSync, existsSync } from 'fs';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
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
