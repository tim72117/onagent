#!/usr/bin/env node
// Explicit-invocation installer (npx claude-skill-onagent), not a postinstall
// script — postinstall auto-copy is the pattern npm/GitHub are moving away
// from by disabling install scripts by default, so this only runs when the
// user actually asks for it.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(__dirname, '..')
const source = join(packageRoot, 'skill')

const userLevel = process.argv.includes('--user')
const target = userLevel
  ? join(homedir(), '.claude', 'skills', 'onagent-cli-setup')
  : join(process.cwd(), '.claude', 'skills', 'onagent-cli-setup')

if (!existsSync(source)) {
  console.error(`Bundled skill content missing at ${source} — package install may be corrupt.`)
  process.exit(1)
}

mkdirSync(dirname(target), { recursive: true })
cpSync(source, target, { recursive: true })

console.log(`Installed onagent-cli-setup skill to ${target}`)
console.log('Bundled binaries: windows-amd64, darwin-amd64, darwin-arm64, linux-amd64, linux-arm64.')
console.log('On any other platform, follow SKILL.md\'s fallback instructions (go install / build from source).')
