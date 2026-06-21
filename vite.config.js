import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Gunakan relative path untuk kompatibilitas subdirektori (GitHub Pages)
  server: {
    host: true, // Expose to local network (useful for mobile testing)
    port: 5173,
    strictPort: true
  }
});
