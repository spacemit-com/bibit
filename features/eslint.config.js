import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['features/lint-fixtures/**', 'lint-fixtures/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^@/', message: 'Feature code cannot import host internals' },
            { group: ['**/web-app/src/**'], message: 'Feature code cannot import web-app internals' },
            { group: ['@tauri-apps/**'], message: 'Feature code cannot call Tauri directly' },
            { group: ['../../*/src', '../../*/src/**'], message: 'Feature code cannot import another Feature' },
            {
              regex: '^@bibit/feature-(?!contracts(?:/|$)|sdk(?:/|$)|ui(?:/|$)).+',
              message: 'Feature code cannot import another Feature package',
            },
            {
              group: ['axios', 'axios/**', 'ky', 'superagent', 'got', 'undici', 'node:http', 'node:https'],
              message: 'Feature code must use a granted Host API for network access',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use a granted Host API instead of fetch' },
        { name: 'WebSocket', message: 'Use a granted Host API instead of WebSocket' },
        { name: 'EventSource', message: 'Use a granted Host API instead of EventSource' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='window'][property.name='core']",
          message: 'Feature code cannot access window.core',
        },
      ],
    },
  }
)
