import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// Phones only expose the camera and motion sensors to secure origins, so the
// dev server runs on self-signed HTTPS and is reachable on the LAN.
export default defineConfig({
  root: 'client',
  plugins: [basicSsl()],
  server: {
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Three pages: the phone/web app, the admin bird's-eye view, and the
    // floor plan designer.
    rolldownOptions: {
      input: {
        main: 'client/index.html',
        admin: 'client/admin.html',
        designer: 'client/designer.html',
      },
    },
  },
});
