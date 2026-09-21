#!/usr/bin/env node
// Explicit-invocation installer (npx claude-skill-onagent), not a postinstall
// script — postinstall auto-copy is the pattern npm/GitHub are moving away
// from by disabling install scripts by default, so this only runs when the
// user actually asks for it.
//
// This package does NOT bundle an onagent binary — it downloads the
// current platform's from this repo's GitHub Releases (built by
// .github/workflows/release-onagent.yml) at install/upgrade time, so a
// user always gets whatever's newest there, independent of when this npm
// package itself was last published. A `.onagent-version` marker file is
// written alongside the installed binary to record which release was
// downloaded, since the binary itself carries no version string (it's
// built without -X main.version here — see release-onagent.yml, which
// does inject one, for that path).
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, platform, arch } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(__dirname, '..')
const skillSource = join(packageRoot, 'skill')

const RELEASES_API = 'https://api.github.com/repos/tim72117/onagent/releases/latest'

const userLevel = process.argv.includes('--user')
const target = userLevel
  ? join(homedir(), '.claude', 'skills', 'onagent-cli-setup')
  : join(process.cwd(), '.claude', 'skills', 'onagent-cli-setup')
const targetBin = join(target, 'bin')
const versionMarker = join(target, '.onagent-version')

// Maps Node's os.platform()/os.arch() to the <os>-<arch> suffix
// release-onagent.yml's build matrix uses for its asset names. Returns
// null for a platform/arch combination that build matrix doesn't cover
// (see release-onagent.yml — currently darwin/windows/linux ×
// amd64/arm64, no windows-arm64 or 32-bit targets).
function platformSuffix() {
  const os = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[platform()]
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch()]
  if (!os || !cpu) return null
  if (os === 'windows' && cpu === 'arm64') return null // not built — see release-onagent.yml
  return `${os}-${cpu}`
}

function assetInfoForSuffix(suffix) {
  const isWindows = suffix.startsWith('windows-')
  const archiveExt = isWindows ? 'zip' : 'tar.gz'
  const binaryName = isWindows ? `onagent-${suffix}.exe` : `onagent-${suffix}`
  return { archiveName: `onagent-${suffix}.${archiveExt}`, archiveExt, binaryName }
}

async function fetchLatestRelease() {
  const res = await fetch(RELEASES_API, { headers: { 'User-Agent': 'claude-skill-onagent' } })
  if (!res.ok) {
    throw new Error(`GitHub Releases API returned ${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function downloadAsset(url, destPath) {
  const res = await fetch(url, { headers: { 'User-Agent': 'claude-skill-onagent' } })
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`)
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath))
}

// Extracts exactly the one binary this platform needs out of the
// downloaded archive, into targetBin. .zip (Windows releases) is handled
// via PowerShell's Expand-Archive — Windows's bundled bsdtar cannot
// reliably extract the .zip files Compress-Archive-style tooling
// produces (verified: "This does not look like a tar archive"), even
// though it otherwise supports .tar.gz fine for the darwin/linux assets.
function extractArchive(archivePath, archiveExt, binaryName) {
  if (archiveExt === 'zip') {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${targetBin}' -Force`,
    ])
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', targetBin])
  }
  const extracted = join(targetBin, binaryName)
  if (!existsSync(extracted)) {
    throw new Error(`Expected ${binaryName} in the extracted archive but didn't find it.`)
  }
  if (archiveExt === 'tar.gz') {
    chmodSync(extracted, 0o755) // tar preserves the executable bit; belt-and-suspenders in case it didn't
  }
}

// Downloads and installs the current platform's onagent binary from the
// given release into targetBin, replacing whatever was there. Shared by
// both the initial skill install and `upgrade` — the two differ only in
// what they print and whether they also (re-)copy skill/ (SKILL.md).
async function installBinaryFromRelease(release, suffix) {
  const { archiveName, archiveExt, binaryName } = assetInfoForSuffix(suffix)
  const asset = release.assets.find((a) => a.name === archiveName)
  if (!asset) {
    throw new Error(`Release ${release.tag_name} has no asset named ${archiveName}.`)
  }

  mkdirSync(targetBin, { recursive: true })
  const tmpArchive = join(targetBin, `.download-${archiveName}`)
  await downloadAsset(asset.browser_download_url, tmpArchive)
  try {
    extractArchive(tmpArchive, archiveExt, binaryName)
  } finally {
    rmSync(tmpArchive, { force: true })
  }

  writeFileSync(versionMarker, release.tag_name)
  return binaryName
}

function readInstalledVersion() {
  return existsSync(versionMarker) ? readFileSync(versionMarker, 'utf8').trim() : null
}

async function cmdInstall() {
  if (!existsSync(skillSource)) {
    console.error(`Bundled skill content missing at ${skillSource} — package install may be corrupt.`)
    process.exit(1)
  }

  const suffix = platformSuffix()
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'SKILL.md'), readFileSync(join(skillSource, 'SKILL.md')))

  console.log(`Installed onagent-cli-setup skill to ${target}`)

  if (!suffix) {
    console.log(`No onagent CLI binary is published for your platform (${platform()}/${arch()}) — see SKILL.md's fallback instructions.`)
    return
  }

  console.log('Fetching the latest onagent CLI release…')
  const release = await fetchLatestRelease()
  const binaryName = await installBinaryFromRelease(release, suffix)
  console.log(`Downloaded onagent CLI ${release.tag_name} (${binaryName}) to ${targetBin}`)
}

async function cmdVersion() {
  const installed = readInstalledVersion()
  if (!installed) {
    console.log('No onagent CLI binary installed here yet — run without a subcommand to install.')
    return
  }
  console.log(`Installed: ${installed}`)

  const release = await fetchLatestRelease()
  console.log(`Latest:    ${release.tag_name}`)
  if (release.tag_name !== installed) {
    console.log("A newer version is available — run 'upgrade' to update.")
  } else {
    console.log('Up to date.')
  }
}

async function cmdUpgrade() {
  const suffix = platformSuffix()
  if (!suffix) {
    console.error(`No onagent CLI binary is published for your platform (${platform()}/${arch()}).`)
    process.exit(1)
  }
  if (!existsSync(target)) {
    console.error(`${target} doesn't exist yet — run without a subcommand to install first.`)
    process.exit(1)
  }

  const installed = readInstalledVersion()
  const release = await fetchLatestRelease()
  if (release.tag_name === installed) {
    console.log(`Already up to date (${installed}).`)
    return
  }

  console.log(`Upgrading onagent CLI ${installed ?? '(unknown)'} → ${release.tag_name}…`)
  const binaryName = await installBinaryFromRelease(release, suffix)
  console.log(`Upgraded to ${release.tag_name} (${binaryName}) at ${targetBin}`)
}

const [, , subcommand] = process.argv

try {
  if (subcommand === 'version') {
    await cmdVersion()
  } else if (subcommand === 'upgrade') {
    await cmdUpgrade()
  } else {
    await cmdInstall()
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
