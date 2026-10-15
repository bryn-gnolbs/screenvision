// ESLint configuration (development only, not shipped with the extension).
// Style follows GNOME Shell's own JavaScript conventions.

import js from '@eslint/js';

// Globals provided by GJS and GNOME Shell.
const gjsGlobals = {
    ARGV: 'readonly',
    console: 'readonly',
    global: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
};

export default [
    {
        ignores: ['build/**', 'node_modules/**'],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'indent': ['error', 4, {SwitchCase: 0, ignoredNodes: ['TemplateLiteral *']}],
            'quotes': ['error', 'single', {avoidEscape: true}],
            'semi': ['error', 'always'],
            'comma-dangle': ['error', 'always-multiline'],
            'eqeqeq': ['error', 'always'],
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none'}],
            'prefer-const': 'error',
            'no-var': 'error',
            'object-curly-spacing': ['error', 'never'],
            'curly': ['error', 'multi-or-nest', 'consistent'],
            'arrow-parens': ['error', 'as-needed'],
        },
    },
];
