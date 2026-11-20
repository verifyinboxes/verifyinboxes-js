import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // The members marked @internal (the tests' clock and the transport) are left out of the published types.
  dts: { compilerOptions: { stripInternal: true } },
  sourcemap: true,
  clean: true,
  target: 'es2020',
  treeshake: true,
  splitting: false,
  // Keep `node:fs` and `node:crypto` as written: Deno finds Node's modules only by that name.
  removeNodeProtocol: false,
  esbuildOptions(options, context) {
    // The CommonJS build loads Node's modules with require: an `import()` in a CommonJS file fails where a test
    // runner or a bundler loads it in a VM without dynamic import support (Jest).
    if (context.format === 'cjs') options.supported = { ...options.supported, 'dynamic-import': false };
  },
});
