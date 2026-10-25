import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

const boundaries = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['electron', 'electron/*'],
          message: '渲染进程请使用 window.shx'
        },
        {
          group: ['node:*', 'fs', 'path', 'child_process', 'os'],
          message: '渲染进程不得使用 Node API'
        },
        {
          group: ['@tools/*', '@infra/*'],
          message: '渲染进程只允许依赖 @shared'
        }
      ]
    }
  ]
}

export default defineConfig(
  { ignores: ['**/node_modules', '**/out', '**/dist', '**/coverage', '**/.eslintcache'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: boundaries
  },
  {
    files: ['tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'electron/*'], message: '工具不得依赖 electron' },
            { group: ['@core/*', '@ipc/*'], message: '工具不得依赖编排层' }
          ]
        }
      ]
    }
  },
  eslintConfigPrettier
)
