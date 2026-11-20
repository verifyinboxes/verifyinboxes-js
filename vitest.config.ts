import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The examples import the package by its name: in the tests, that is the source here.
  resolve: { alias: { verifyinboxes: fileURLToPath(new URL('./src/index.ts', import.meta.url)) } },
});
