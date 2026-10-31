import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: 5173, proxy: { '/api': process.env.API_URL ?? 'http://localhost:8080' } },
});
