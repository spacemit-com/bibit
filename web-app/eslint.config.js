import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'coverage', '**/__tests__/**', '**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Native form controls are painted by the platform, not by our tokens:
      // a <select> popup is a GTK menu that ignores both CSS variables and
      // `color-scheme`, so it keeps the desktop theme when the app switches.
      // Use the themed primitives in components/ui instead.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXElement[openingElement.name.name='select']",
          message:
            'Native <select> is themed by the OS. Use components/ui/dropdown-menu or another themed primitive.',
        },
        // The theme has a single authority (Rust `set_app_theme` /
        // `get_app_theme`). A webview-side key is how a freshly opened window
        // used to fall back to the desktop's light theme.
        {
          selector: "Literal[value='jan-theme']",
          message:
            'jan-theme is retired. Window theme comes from services/theme/authority (the Rust authority).',
        },
        {
          selector:
            "CallExpression[callee.property.name='setTheme'][arguments.0.type='Literal'][arguments.0.value=null]",
          message:
            'Window theme is applied by the authority per resolved value; setTheme(null) hands painting back to the desktop.',
        },
      ],
    },
  },
)
