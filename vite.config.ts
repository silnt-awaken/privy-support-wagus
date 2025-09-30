import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import commonjs from '@rollup/plugin-commonjs';
import inject from '@rollup/plugin-inject';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const fromRoot = (relativePath: string) => path.resolve(rootDir, relativePath);

export default defineConfig({
  plugins: [react()],
  resolve: {
    mainFields: ['module', 'jsnext:main', 'browser', 'main'],
    alias: {
      '@': fromRoot('src'),
      buffer: 'buffer',
      process: 'process/browser',
      stream: 'stream-browserify',
      util: 'util',
      'bn.js/lib/bn.js': 'bn.js',
      'js-sha3/src/sha3.js': 'js-sha3',
      'hash.js/lib/hash.js': 'hash.js',
      'bs58/index.js': 'bs58',
    },
    dedupe: [
      'bn.js',
      'js-sha3',
      'hash.js',
      'bs58',
      '@ethersproject/bignumber',
      '@ethersproject/keccak256',
      '@solana-program/system',
      '@solana-program/token',
      '@solana/kit',
    ],
  },
  optimizeDeps: {
    needsInterop: ['bn.js', 'js-sha3', 'hash.js', 'bs58', 'buffer', 'process', 'stream-browserify', 'util'],
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      '@tanstack/react-query',
      'recharts',
      'lucide-react',
      'sonner',
      'zustand',
      '@privy-io/react-auth',
      'buffer',
      'process',
      'stream-browserify',
      'util',
      '@ethersproject/bignumber',
      '@ethersproject/keccak256',
      '@ethersproject/sha2',
      '@ethersproject/bytes',
      '@ethersproject/strings',
      '@ethersproject/abi',
      'bn.js',
      'js-sha3',
      'hash.js',
      'bs58',
      '@solana-program/system',
      '@solana-program/token',
      '@solana/kit',
    ],
    force: true,
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
      plugins: [
        NodeGlobalsPolyfillPlugin({ buffer: true, process: true }),
        NodeModulesPolyfillPlugin(),
      ],
    },
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
      requireReturnsDefault: 'auto',
    },
    rollupOptions: {
      plugins: [
        inject({
          Buffer: ['buffer', 'Buffer'],
          process: 'process',
        }),
        commonjs({
          include: /node_modules\/(bn\.js|js-sha3|hash\.js|bs58|@ethersproject.*)/,
          requireReturnsDefault: 'auto',
        }),
      ],
    },
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
});