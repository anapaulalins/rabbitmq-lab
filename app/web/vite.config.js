import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Em desenvolvimento, /api vai para a API local
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
