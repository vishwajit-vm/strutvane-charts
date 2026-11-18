import { defineConfig } from 'tsdown'

// Entry points:
// - `.`: browser-safe definitions, the wire format and the calendar (no Node, no framework runtime);
// - `./server`: metrics, the aggregate engine and the HTTP handler (framework query builder);
// - `./react`: the KPI card, the chart widgets and the dashboard (browser-safe);
// - `./provider` and `./installer`: the Strutvane app integration.
// The framework and React are peer dependencies and stay external.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server/index.ts',
    react: 'src/react/index.ts',
    provider: 'src/provider.ts',
    installer: 'src/installer.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime', /^@strutvane\/framework/] },
})
