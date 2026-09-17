// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://jcwrks.com',
  // /thanks is the form success page (and /publish now redirects to /admin).
  // Keep them out of the sitemap (robots.txt blocks them too).
  integrations: [sitemap({ filter: (page) => !page.includes('/publish') && !page.includes('/thanks') })],
  vite: {
    plugins: [tailwindcss()]
  }
});
