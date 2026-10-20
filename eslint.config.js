// Flat ESLint config for the whole monorepo (AGENTS.md §6).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import novaI18n from './packages/i18n/src/eslint-rule.ts';

// Folders and files whose UI text comes from defineMessages (FR-016, D9): the rule
// nova-i18n/no-literal-ui-text is an error here. One glob per line, kept sorted, so areas can add
// theirs without conflicts; the lead turns it on for all of apps/web/src and packages/ui/src.
const I18N_CONVERTED = [
  'apps/desktop/src/**',
  'apps/web/src/App.tsx',
  'apps/web/src/CommandPalette.tsx',
  'apps/web/src/agents/**',
  'apps/web/src/appauth/**',
  'apps/web/src/appearance.ts',
  'apps/web/src/apps/**',
  'apps/web/src/boot/**',
  'apps/web/src/browser/**',
  'apps/web/src/browserdevice/**',
  'apps/web/src/channels/**',
  'apps/web/src/chat/**',
  'apps/web/src/cloud/**',
  'apps/web/src/code/**',
  'apps/web/src/commands.ts',
  'apps/web/src/computers/**',
  'apps/web/src/datactl/**',
  'apps/web/src/deeplinks.ts',
  'apps/web/src/devices/**',
  'apps/web/src/dispatch/**',
  'apps/web/src/extensions/**',
  'apps/web/src/files/**',
  'apps/web/src/firmware/**',
  'apps/web/src/flagged/**',
  'apps/web/src/hooks.ts',
  'apps/web/src/hub-events.ts',
  'apps/web/src/i18n/**',
  'apps/web/src/images/**',
  'apps/web/src/join/**',
  'apps/web/src/joinmember/**',
  'apps/web/src/keys.ts',
  'apps/web/src/layout/**',
  'apps/web/src/library/**',
  'apps/web/src/main.tsx',
  'apps/web/src/managed/**',
  'apps/web/src/market/**',
  'apps/web/src/netsurface/**',
  'apps/web/src/network/**',
  'apps/web/src/notifications/**',
  'apps/web/src/offline/**',
  'apps/web/src/onboarding/**',
  'apps/web/src/oob/**',
  'apps/web/src/pets/**',
  'apps/web/src/projects/**',
  'apps/web/src/providers/**',
  'apps/web/src/push/**',
  'apps/web/src/relaytransport/**',
  'apps/web/src/replica/**',
  'apps/web/src/screen/**',
  'apps/web/src/services.tsx',
  'apps/web/src/settings.tsx',
  'apps/web/src/settings/**',
  'apps/web/src/shell/**',
  'apps/web/src/shellbridge/**',
  'apps/web/src/spaces/**',
  'apps/web/src/stores.tsx',
  'apps/web/src/sync/**',
  'apps/web/src/team/**',
  'apps/web/src/terminal/**',
  'apps/web/src/work/**',
  'apps/web/src/workspace-commands.ts',
  'packages/ui/src/**',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      'services/novad/target/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['scripts/**', 'e2e/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests read untyped JSON responses and fixtures; the unsafe-* rules add noise, not safety.
    files: ['**/test/**', 'e2e/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: I18N_CONVERTED,
    plugins: { 'nova-i18n': novaI18n },
    rules: { 'nova-i18n/no-literal-ui-text': 'error' },
  },
);
