import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ root: 'src/web', plugins: [react(), tailwindcss()], build: { outDir: '../../dist/web', emptyOutDir: true }, server: { host: '127.0.0.1' } });
