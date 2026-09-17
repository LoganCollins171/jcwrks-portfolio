// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://jcwrks.com',
  // /thanks is the form success page: keep it out of the sitemap (robots.txt blocks it too).
  integrations: [sitemap({ filter: (page) => !page.includes('/thanks') })],
  vite: {
    plugins: [tailwindcss()]
  }
});
