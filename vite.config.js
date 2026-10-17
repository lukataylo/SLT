import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// Phones only expose the camera and motion sensors to secure origins, so the
// dev server runs on self-signed HTTPS and is reachable on the LAN.
export default defineConfig({
  root: 'client',
  plugins: [basicSsl()],
  server: {
    host: true,
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
