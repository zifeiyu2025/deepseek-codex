import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          if (id.includes('/node_modules/@xterm/')) return 'vendor-xterm';
          if (id.includes('/node_modules/prism-react-renderer/')) return 'vendor-syntax';
          if (
            /[\\/]node_modules[\\/](react-markdown|remark|rehype|unified|micromark|mdast|hast|unist|vfile)[\\/-]/.test(
              id,
            )
          ) {
            return 'vendor-markdown';
          }
          if (id.includes('/node_modules/lucide-react/')) return 'vendor-icons';
          return 'vendor';
        },
      },
    },
  },
});
