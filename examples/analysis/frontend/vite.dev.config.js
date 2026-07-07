import path from 'path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            'vue': 'vue/dist/vue.esm-bundler.js',
        },
    },
    server: {
        host: '0.0.0.0',
        port: 5175,
        proxy: {
            '^/analysis/[^/]+/(?!menu|open|create)': {
                target: 'http://localhost:8081',
                rewrite: path => path,
            },
        },
    },
})
