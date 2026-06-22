import { defineConfig } from 'vite';

export default defineConfig({
  base: '/EnumAR/', // SESUAIKAN dengan nama repositori GitHub Anda (contoh: '/NamaRepo/')
  server: {
    host: true, // Expose to local network (useful for mobile testing)
    port: 5173,
    strictPort: true
  }
});
