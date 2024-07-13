import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  html: {
    template(entry) {
      return `./examples/${entry.entryName}/index.html`;
    },
  },
  source: {
    entry: {
      start: './examples/start/index.ts',
      live: './examples/live/index.ts',
    },
    define: {
      __DEV__: true,
    },
  },
});
