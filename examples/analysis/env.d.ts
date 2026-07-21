/// <reference types="vite/client" />

// Vue SFCs have no built-in module type without vue-tsc/Volar's own Vue
// support wired in (not set up here — this project only added enough
// TypeScript for App.vue's <script setup lang="ts">, not full project-wide
// type-checking). This shim just lets .vue imports resolve to
// `any`-shaped components instead of a hard type error, matching the
// looseness plain-JS .vue files (Menu.vue etc.) already have.
declare module '*.vue' {
    import type { DefineComponent } from 'vue'
    const component: DefineComponent<{}, {}, any>
    export default component
}
