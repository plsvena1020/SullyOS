import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Workers 运行时自带的虚拟模块，node 上解析不到（不给别名的话，import 到它的
      // 测试文件整个加载失败）。打包侧的对应处理是 build-workers.mjs 里的 external。
      'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test-setup.ts'],
    include: [
      'utils/**/*.test.ts',
      'worker/**/*.test.ts',
      'scripts/**/*.test.ts',
      'api/**/*.test.ts',
      // xhs session bridge(vps-backend 纯 JS 服务):任务 6/7 单测位
      'vps-backend/**/*.test.ts',
      'apps/**/*.test.{ts,tsx}',
      'components/**/*.test.{ts,tsx}',
    ],
    // apps、components 内的 React 单测各自按文件头 @vitest-environment 按需切 jsdom，node 环境文件不受影响
    exclude: ['node_modules', '**/node_modules/**', '.worktrees', 'dist'],
  },
});
