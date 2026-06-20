import { defineConfig } from 'vite';
import { proxyTile } from './api/tiles.js';

// Mirror the Vercel `/api/tiles` serverless function during `vite dev` so the
// app behaves identically locally and in production.
function tileProxyPlugin() {
  return {
    name: 'dev-tile-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/api/tiles')) {
          proxyTile(req.url, res).catch(() => {
            res.statusCode = 502;
            res.end('proxy error');
          });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [tileProxyPlugin()],
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
