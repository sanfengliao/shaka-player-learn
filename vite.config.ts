import { defineConfig } from 'vite';

export default defineConfig({
  // Specify the output directory for the build
  // You can change this to match your project structure
  build: {
    outDir: './dist',
  },

  // Configure any plugins or customizations here
  plugins: [],

  define: {
    __DEV__: true,
  },
});
