import { readFileSync } from 'node:fs';
import { ident, parse, walk } from '@eslint/css-tree';
import tailwind from 'eslint-plugin-better-tailwindcss';
import { defineConfig } from 'oxlint';

// The plugin only detects custom classes inside @layer components. Keep our existing CSS cascade.
const customClasses = new Set<string>();
walk(parse(readFileSync(new URL('./src/web/styles.css', import.meta.url), 'utf8')), (node) => {
  if (node.type === 'ClassSelector') {
    customClasses.add(`^${ident.decode(node.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  }
});

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc', 'react', 'jsx-a11y', 'import'],
  categories: {
    correctness: 'error',
  },
  options: {
    typeAware: true,
    reportUnusedDisableDirectives: 'error',
  },
  rules: {
    ...tailwind.configs.recommended.rules,
    'better-tailwindcss/enforce-consistent-class-order': 'off',
    'better-tailwindcss/enforce-consistent-line-wrapping': 'off',
    'better-tailwindcss/no-unknown-classes': ['error', { ignore: [...customClasses] }],
    'import/first': 'error',
    'import/no-duplicates': 'error',
    'import/newline-after-import': [
      'error',
      {
        count: 1,
        exactCount: true,
        considerComments: true,
      },
    ],
    'typescript/consistent-type-imports': [
      'error',
      {
        prefer: 'type-imports',
        fixStyle: 'separate-type-imports',
      },
    ],
    'typescript/no-floating-promises': 'error',
    'typescript/no-misused-promises': 'error',
    'prefer-const': 'error',
    curly: ['error', 'all'],
    'react/rules-of-hooks': 'error',
    'react/exhaustive-deps': 'error',
    'react/refs': 'off',
    'react/set-state-in-effect': 'off',
    'react/preserve-manual-memoization': 'off',
    'jsx-a11y/prefer-tag-over-role': 'off',
    'eslint/no-empty-pattern': [
      'error',
      {
        allowObjectPatternsAsParameters: true,
      },
    ],
  },
  ignorePatterns: [
    'dist/**',
    'test-results/**',
    'playwright-report/**',
    '.orca/**',
    'release-artifacts/**',
  ],
  jsPlugins: ['eslint-plugin-better-tailwindcss'],
  settings: {
    'better-tailwindcss': {
      entryPoint: 'src/web/styles.css',
    },
  },
});
