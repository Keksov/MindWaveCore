/* eslint-env node */
// https://v2.quasar.dev/quasar-cli-vite/quasar-config-file

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDir = dirname(fileURLToPath(import.meta.url))
const toVitePath = (pathValue: string) => pathValue.replace(/\\/g, '/')

export default function (/* ctx */) {
  return {
    boot: ['i18n'],

    css: ['app.scss'],

    extras: ['material-icons'],

    build: {
      target: { browser: ['es2022'] },
      vueRouterMode: 'hash',
      distDir: resolve(currentDir, '..', 'server', 'public'),
      alias: {
        '@protocol': resolve(currentDir, '..', 'server', 'protocol.ts')
      },
      extendViteConf(viteConf) {
        viteConf.resolve ??= {}

        const currentAliases = Array.isArray(viteConf.resolve.alias)
          ? viteConf.resolve.alias
          : Object.entries(viteConf.resolve.alias ?? {}).map(([find, replacement]) => ({ find, replacement }))

        const packageRoot = toVitePath(resolve(currentDir, 'node_modules'))
        currentAliases.push(
          { find: /^codemirror$/, replacement: `${packageRoot}/codemirror` },
          { find: /^@codemirror\/(.*)$/, replacement: `${packageRoot}/@codemirror/$1` },
          { find: /^echarts$/, replacement: `${packageRoot}/echarts` },
          { find: /^echarts\/(.*)$/, replacement: `${packageRoot}/echarts/$1` },
          { find: /^pinia$/, replacement: `${packageRoot}/pinia/dist/pinia.mjs` },
          { find: /^vue-i18n$/, replacement: `${packageRoot}/vue-i18n/dist/vue-i18n.mjs` },
          { find: /^vue-router$/, replacement: `${packageRoot}/vue-router/dist/vue-router.mjs` },
          { find: /^quasar$/, replacement: `${packageRoot}/quasar/dist/quasar.client.js` },
          { find: /^quasar\/(.*)$/, replacement: `${packageRoot}/quasar/$1` },
        )
        viteConf.resolve.alias = currentAliases

        viteConf.build ??= {}
        viteConf.build.rollupOptions ??= {}

        const applyManualChunks = (output = {}) => ({
          ...output,
          manualChunks(id) {
            if (id.includes('/node_modules/zrender/') || id.includes('\\node_modules\\zrender\\')) {
              return 'charts-renderer'
            }

            if (id.includes('/node_modules/echarts/') || id.includes('\\node_modules\\echarts\\')) {
              return 'charts-core'
            }

            return typeof output.manualChunks === 'function' ? output.manualChunks(id) : undefined
          }
        })

        const currentOutput = viteConf.build.rollupOptions.output
        if (Array.isArray(currentOutput)) {
          viteConf.build.rollupOptions.output = currentOutput.map(applyManualChunks)
          return
        }

        viteConf.build.rollupOptions.output = applyManualChunks(currentOutput)
      }
    },

    devServer: {
      open: false,
      proxy: {
        '/api': {
          target: 'http://localhost:3300'
        },
        '/ws/ui': {
          target: 'http://localhost:3300',
          ws: true
        }
      }
    },

    framework: {
      config: {
        dark: true
      },
      iconSet: 'material-icons',
      plugins: ['Notify']
    }
  }
}
