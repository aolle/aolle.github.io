import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://olleb.com',
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    shikiConfig: {
      theme: 'github-light',
    },
  },
  redirects: {
    // OWASP WebGoat Hijack Session
    '/OWASP-WebGoat-hijack-session': '/posts/2023-08-15-owasp-webgoat-hijack-session/',
    '/OWASP-WebGoat-hijack-session/': '/posts/2023-08-15-owasp-webgoat-hijack-session/',

    // OWASP WebGoat Spoof Auth Cookie
    '/OWASP-WebGoat-spoof-auth-cookie': '/posts/2023-08-09-owasp-webgoat-spoof-auth-cookie/',
    '/OWASP-WebGoat-spoof-auth-cookie/': '/posts/2023-08-09-owasp-webgoat-spoof-auth-cookie/',

    // I2C Signal Reversing
    '/I2C-signal-reversing': '/posts/2023-02-01-i2c-signal-reversing/',
    '/I2C-signal-reversing/': '/posts/2023-02-01-i2c-signal-reversing/',
  },
});
