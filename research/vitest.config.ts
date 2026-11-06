import { defineConfig } from 'vitest/config'

// The research harness (research/harness): reads the raw pulls in research/data, never runs with the default suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['research/harness/**/*.test.ts'],
    hookTimeout: 600_000,
    testTimeout: 6 * 3600_000,
  },
})
