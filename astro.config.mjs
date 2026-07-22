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
    '/OWASP-WebGoat-hijack-session': '/posts/owasp-webgoat-hijack-session/',
    '/OWASP-WebGoat-hijack-session/': '/posts/owasp-webgoat-hijack-session/',

    '/OWASP-WebGoat-spoof-auth-cookie': '/posts/owasp-webgoat-spoof-auth-cookie/',
    '/OWASP-WebGoat-spoof-auth-cookie/': '/posts/owasp-webgoat-spoof-auth-cookie/',

    '/I2C-signal-reversing': '/posts/i2c-signal-reversing/',
    '/I2C-signal-reversing/': '/posts/i2c-signal-reversing/',
  },
});
