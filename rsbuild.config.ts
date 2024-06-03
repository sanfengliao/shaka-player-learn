import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  html: {
    template: './index.html',
  },
  source: {
    define: {
      __DEV__: true,
    },
  },
});
