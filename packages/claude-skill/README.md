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
npx claude-skill-onagent            # installs to ./.claude/skills/onagent-cli-setup
npx claude-skill-onagent --user     # installs to ~/.claude/skills/onagent-cli-setup
npx claude-skill-onagent version    # shows the installed and latest onagent CLI release
npx claude-skill-onagent upgrade    # re-downloads the current platform's binary if a newer release exists
```

`version`/`upgrade` operate on whichever install `--user` selects — pass the
same flag you installed with if you installed with `--user`.

This is an explicit, user-invoked install (not a `postinstall` script) — npm
and GitHub are moving toward disabling install scripts by default, so
anything that auto-copies files on `npm install` is a fading, riskier
pattern. Running this only happens when someone actually types the command.

## The onagent binary isn't bundled

Unlike earlier versions of this package, `skill/bin/` is no longer part of
what gets published — this package carries no onagent binary at all.
`bin/cli.js` downloads the current platform's binary straight from this
repo's GitHub Releases (built by `.github/workflows/release-onagent.yml`)
the moment someone runs `npx claude-skill-onagent` (install) or
`claude-skill-onagent upgrade`, so a user always gets whatever's newest
there — never something pinned to whenever this npm package itself was
last published, and this package never needs re-publishing just because a
new onagent CLI version shipped.

`.onagent-version` (written next to the downloaded binary) records which
release tag was installed — the binary itself carries no version string
here, since `release-onagent.yml`'s `-X main.version=...` build flag isn't
part of this download path.

Platforms covered: whatever `release-onagent.yml`'s build matrix currently
publishes (as of this writing: Windows amd64, macOS Intel/Apple Silicon,
Linux amd64/arm64). `cli.js` prints a clear message and exits without
attempting a download on any other platform/arch combination —
`SKILL.md`'s own fallback instructions cover that case.

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
