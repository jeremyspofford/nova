import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://arialabs.ai',
  integrations: [
    starlight({
      title: 'Nova',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/jeremyspofford/nova' },
      ],
      customCss: ['./src/styles/global.css'],
      sidebar: [
        { label: 'Overview', slug: 'nova/docs' },
        { label: 'Quick Start', slug: 'nova/docs/quickstart' },
        {
          label: 'Core Concepts',
          items: [
            { slug: 'nova/docs/architecture' },
            { slug: 'nova/docs/pipeline' },
            { slug: 'nova/docs/configuration' },
          ],
        },
        {
          label: 'Services',
          autogenerate: { directory: 'nova/docs/services' },
        },
        {
          label: 'Guides',
          items: [
            { slug: 'nova/docs/notifications' },
            { slug: 'nova/docs/inference-backends' },
            { slug: 'nova/docs/deployment' },
            { slug: 'nova/docs/remote-access' },
            { slug: 'nova/docs/ide-integration' },
            { slug: 'nova/docs/mcp-tools' },
            { slug: 'nova/docs/skills-rules' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'nova/docs/api-reference' },
            { slug: 'nova/docs/security' },
            { slug: 'nova/docs/roadmap' },
          ],
        },
      ],
    }),
  ],
  vite: { plugins: [tailwindcss()] },
});
