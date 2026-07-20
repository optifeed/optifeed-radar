// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `scripts/` holds dev-only utilities (the M17 smoke test) that are plain
    // .mjs, never shipped (`files` excludes them) and outside the tsconfig
    // project, so type-aware linting has no program for them.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'scripts/**'],
  },
  eslint.configs.recommended,
  // Type-aware linting: the modern TS "style guide" - catches real bugs
  // (floating/misused promises, unsafe any) that syntax-only rules cannot.
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Architecture invariant (hard rule #1): core/ must never import cli/ or mcp/.
  // CLI and MCP are thin adapters over core/run - orchestration lives in core.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/**', '**/mcp/**'],
              message:
                'core/ must never import from cli/ or mcp/ (hard rule #1). CLI/MCP are thin adapters over core/run.',
            },
          ],
        },
      ],
    },
  },
  // Tests: relax the rules that fight test doubles (no-op async mocks,
  // loosely-typed HTTP/response fakes). Production keeps them strict.
  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  // Plain JS (this config, etc.): no type-aware rules.
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
