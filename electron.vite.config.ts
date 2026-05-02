import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // Octokit ships ESM-only since v6+ and our main bundle is CommonJS,
        // so bundle them in. Native modules (better-sqlite3, keytar) MUST
        // stay externalized because they have platform-specific binaries.
        exclude: [
          '@octokit/rest',
          '@octokit/auth-oauth-device',
          '@octokit/plugin-retry',
          '@octokit/plugin-throttling',
          '@octokit/core',
          '@octokit/request',
          '@octokit/request-error',
          '@octokit/endpoint',
          '@octokit/graphql',
          '@octokit/auth-token',
          '@octokit/types',
          '@octokit/plugin-paginate-rest',
          '@octokit/plugin-rest-endpoint-methods',
        ],
      }),
    ],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'src/preload/preload.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      outDir: '../../out/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    server: {
      port: 5173,
    },
  },
});
