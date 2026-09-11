/// <reference types="vite/client" />

// This project's other source files under src/marketing-demo/ are plain,
// untyped JS (kept that way deliberately — see widget.js's own header
// comment) that showcase/src imports across the package boundary via a
// relative dynamic import (ShowcaseDemo.tsx). TypeScript's "moduleResolution":
// "bundler" has no declaration file for a relative .js specifier and
// refuses to treat it as implicit `any`, unlike allowJs-enabled projects —
// this wildcard ambient module is the standard fix, scoped to .js so it
// doesn't loosen resolution for any real .ts/.tsx import. Callers still
// narrow to the actual shape they use via their own local type (see
// ShowcaseDemo.tsx's MarketingDemoModule) rather than relying on this
// `any` beyond the import boundary itself.
declare module '*.js' {
  const mod: any
  export = mod
}
