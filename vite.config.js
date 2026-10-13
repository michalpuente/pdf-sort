import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Served behind docker-gateway at /pdf-sort/
  base: '/pdf-sort/',
  plugins: [react()],
});
