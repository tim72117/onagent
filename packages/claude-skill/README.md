# @onagent/claude-skill

Experimental npm packaging of the `onagent-cli-setup` Claude Code skill.
Published under the `@onagent` scope (matching `@onagent/bridge`), but the
installed CLI command stays the shorter, unscoped `claude-skill-onagent` —
see `bin` in `package.json`.

`skill/SKILL.md` in this directory is the only copy of the
`onagent-cli-setup` skill in this repo — it used to also be vendored at
`.claude/skills/onagent-cli-setup/` at the repo root, but that copy was
removed (and gitignored, so a local install doesn't get re-tracked) once
this package became the sole distribution channel. This directory is now
the source of truth for editing the skill's content.

## Usage

```
npx claude-skill-onagent          # installs to ./.claude/skills/onagent-cli-setup
npx claude-skill-onagent --user   # installs to ~/.claude/skills/onagent-cli-setup
```

This is an explicit, user-invoked install (not a `postinstall` script) — npm
and GitHub are moving toward disabling install scripts by default, so
anything that auto-copies files on `npm install` is a fading, riskier
pattern. Running this only happens when someone actually types the command.

## Building the bundled binary

`skill/bin/` is gitignored — build it locally before publishing or testing:

```
cd ../../backend
GOWORK=off GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../packages/claude-skill/skill/bin/onagent-windows-amd64.exe ./cmd/onagent
GOWORK=off GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../packages/claude-skill/skill/bin/onagent-darwin-amd64 ./cmd/onagent
GOWORK=off GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../packages/claude-skill/skill/bin/onagent-darwin-arm64 ./cmd/onagent
GOWORK=off GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../packages/claude-skill/skill/bin/onagent-linux-amd64 ./cmd/onagent
GOWORK=off GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../packages/claude-skill/skill/bin/onagent-linux-arm64 ./cmd/onagent
```

`-trimpath -ldflags="-s -w"` matches `release-onagent.yml`'s own build flags
(strips debug symbols/DWARF info and local file paths) — cuts each binary
by roughly 30%.

All five platforms are bundled as of 0.0.2: Windows (amd64), macOS (Intel
and Apple Silicon), and Linux (amd64 and arm64). `SKILL.md`'s own fallback
instructions (`go install .../cmd/onagent@latest`, or clone + build) still
cover any platform not in this list.

## Publishing

Scoped packages (`@onagent/*`) default to private on npm — publish with
`--access public`, or npm rejects it:

```
npm publish --access public
```

## License

`LICENSE` in this directory is a copy of the repo root's `LICENSE` (BSL
1.1), copied rather than symlinked since npm's `files` packaging only sees
files inside this package directory. Keep it in sync manually if the root
`LICENSE` changes.
