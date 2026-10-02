import eslint from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import iconButtons from './scripts/eslint-icon-buttons.mjs';

export default tseslint.config(
  { ignores: ['dist', 'src-tauri/target', 'src/bindings/generated.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh, versiondock: { rules: { 'icon-buttons': iconButtons } } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'off',
      'versiondock/icon-buttons': 'error',
    },
  },
  {
    files: ['scripts/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
