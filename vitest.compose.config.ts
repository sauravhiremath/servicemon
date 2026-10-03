import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/compose/**/*.test.ts'], testTimeout: 120000, hookTimeout: 180000, fileParallelism: false } });
