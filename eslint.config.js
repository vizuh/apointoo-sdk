// ESLint flat config (v9+). TS-strict + minimal opinions.
// Run: npm run lint
//
// Why minimal: prettier handles formatting; tsc handles type errors.
// ESLint catches the few logic-shape things tsc misses (unused vars, await
// in non-async, switch fallthrough). No style nags.

import tseslint from 'typescript-eslint'
import js from '@eslint/js'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '**/*.d.ts',
      // Config files sit outside the tsconfig project + the type-aware
      // parser can't resolve them. They're vendor-style config; lint
      // them with the formatter instead (Prettier).
      'vitest.config.ts',
      'eslint.config.js',
      '.prettierrc.json',
      // Knowledge-graph + temp dirs from /understand-anything skill —
      // generated artifacts, not source.
      '.understand-anything/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // Logic-shape rules ESLint catches that tsc doesn't
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      'no-fallthrough': 'error',

      // Allow underscore-prefixed unused params (signature requirements)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Pragmatic — kit uses these patterns intentionally
      '@typescript-eslint/no-explicit-any': 'warn', // not error — adapters need any sometimes
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],

      // Off — covered by tsc strict mode
      'no-unused-vars': 'off', // ts-eslint version handles it
      'no-undef': 'off', // tsc handles it
    },
  },
  {
    // Tests can be looser — vitest matchers + factory helpers
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Examples are demo code, not lib code
    files: ['examples/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
)
