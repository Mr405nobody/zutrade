import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: Number(env.WEB_PORT ?? 5173),
      strictPort: true,
      fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data/**', '**/.local/**'] },
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${env.API_PORT ?? 3001}`,
          timeout: 10000,
          proxyTimeout: 10000,
        },
        '/health': {
          target: `http://127.0.0.1:${env.API_PORT ?? 3001}`,
          timeout: 5000,
          proxyTimeout: 5000,
        },
      },
    },
    preview: { host: '127.0.0.1', port: Number(env.WEB_PORT ?? 5173), strictPort: true },
    build: { sourcemap: false },
  };
});
