import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 两个入口：
 * - index.html      产品前端（登录 = 选人）
 * - simulator.html  模拟群聊（开发工具，产品前端不链接到这里）
 */
const target = `http://localhost:${process.env.SERVER_PORT ?? 8902}`;

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        simulator: resolve(__dirname, 'simulator.html'),
      },
    },
  },
  plugins: [react()],
  server: {
    port: Number(process.env.ADMIN_PORT ?? 8901),
    proxy: {
      '/api': target,
      '/out': target,
    },
  },
});
