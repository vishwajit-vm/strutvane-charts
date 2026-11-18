import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Repo-specific overrides. Shared defaults come from strutvane-tooling.
// - Server tests run in `node` against real engines (node:sqlite and PGlite, in process); React
//   tests opt into jsdom with a `// @vitest-environment jsdom` file comment.
// - The ORM's connection and schema registry are process-wide, so files run one at a time.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.{ts,tsx}'],
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
      coverage: {
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/index.ts'],
      },
    },
  }),
)
