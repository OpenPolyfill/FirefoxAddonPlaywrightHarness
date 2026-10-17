import js from '@eslint/js'
import jsdoc from 'eslint-plugin-jsdoc'
import tseslint from 'typescript-eslint'

const nodeGlobals = {
  AbortSignal: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly'
}

export default tseslint.config(
  {
    ignores: ['dist/**', 'website/**', 'src/generated/**', 'docs/content/api/reference/**']
  },
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    plugins: { jsdoc },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'jsdoc/check-types': 'warn',
      'jsdoc/valid-types': 'warn'
    }
  },
  {
    files: ['tests/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    plugins: { jsdoc },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'jsdoc/check-types': 'warn',
      'jsdoc/valid-types': 'warn'
    }
  }
)
