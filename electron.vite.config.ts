import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve(__dirname, 'shared'),
  '@infra': resolve(__dirname, 'infra'),
  '@tools': resolve(__dirname, 'tools')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          // worker 必须是独立入口：utilityProcess.fork 需要磁盘上的真实文件
          worker: resolve(__dirname, 'electron/worker/entry.ts')
        }
      }
    },
    resolve: { alias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': alias['@shared']
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src'),
        '@shared': alias['@shared']
      }
    }
  }
})
