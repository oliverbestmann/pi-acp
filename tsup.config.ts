import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  minify: true,
  banner: {
    js: '#!/usr/bin/env node'
  }
})
