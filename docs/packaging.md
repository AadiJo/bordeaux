# Desktop packaging

Bordeaux uses electron-builder. Packaging includes the compiled Electron main/preload code and the canonical `public/renderer` renderer.

## Icons

- `build/Bordeaux.icon` is the editable Icon Composer source used for the macOS app bundle.
- `build/icon.svg` is the platform-neutral composition rendered to `build/icon.png` for Windows.
- `build/icon.icns` is the flattened DMG and CI fallback.
- `build/icon-assets/wine-glass.svg` is the shared vector mark.
- `build/icon-assets/wine-glass-foreground.svg` frames that mark on the square Icon Composer canvas.

The mark uses a red-wine gradient and warm glass outline against Bordeaux's graphite tile. Keep the foreground and platform icons in sync when revising it. Validate the Icon Composer source with:

```sh
/Applications/Icon\ Composer.app/Contents/Executables/ictool build/Bordeaux.icon \
  --export-preview macOS Light 1024 1024 1 build/icon-composer-preview.png
```

## Local builds

```sh
npm ci
npm run package:mac
```

This produces arm64 and x64 DMG/ZIP artifacts in `release/`. The local macOS packages are intentionally unsigned until a `Developer ID Application` identity and notarization credentials are configured.

`package:mac` requires Icon Composer (included with current Xcode releases) to compile `build/Bordeaux.icon`. CI uses `package:mac:ci` and the checked-in ICNS fallback when Icon Composer is unavailable.

Run `npm run package:win` on Windows to produce both an installable NSIS setup executable and a portable executable. Cross-building those targets from macOS requires Wine, so the repository's `Package desktop apps` workflow builds Windows artifacts on a Windows runner instead.

Do not advertise project file associations until main-process startup handles OS open-file events and command-line paths.

## Beta prereleases and automatic updates

Installed macOS builds and Windows builds downloaded from GitHub use the public `Zw96042/bordeaux` GitHub Releases feed and the `beta` update channel. Bordeaux checks quietly shortly after launch; **Check for Updates…** in the application menu starts a visible check. A downloaded update can restart immediately only when the project has no unsaved changes. Otherwise it is retained for the next clean exit.

To publish a beta, first update and commit the exact prerelease version in `package.json` and `package-lock.json`, then push it to `main`:

```sh
npm version 0.2.0-beta.2 --no-git-tag-version
npm run verify:prerelease
git push origin main
gh workflow run prerelease.yml -f version=0.2.0-beta.2 -f notes="Beta notes"
```

The workflow runs only from `main`, tests all supported platforms, produces their packages, validates the public beta manifests, atomically creates the matching tag at the dispatched commit, and creates a non-draft GitHub prerelease only after every build succeeds. Each version can be published once; increment the beta number for every attempt that creates its Git tag.

Configure these GitHub Actions repository secrets before the first run:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
- Windows (optional): `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`

The workflow deliberately fails before macOS packaging when its credentials are absent because macOS automatic updates require a signed app; the workflow also notarizes it. Windows prereleases may be published unsigned while its secrets are absent and are signed automatically when both secrets are configured. Unsigned Windows installers display an unknown-publisher warning. Never publish replacement artifacts under an existing release version.

## Microsoft Store Windows builds

Windows has two independent distribution channels:

- GitHub Releases provides the immediately downloadable unsigned NSIS installer and portable executable. Those builds update from GitHub prereleases.
- Microsoft Store provides an AppX package that Microsoft signs after certification and updates through the Store. Store-installed builds do not contact GitHub for application updates.

After reserving Bordeaux in Partner Center, copy **Package/Identity/Name**, **Package/Identity/Publisher**, and **Publisher display name** from its Product identity page. Add them as GitHub Actions repository variables named `WINDOWS_STORE_IDENTITY_NAME`, `WINDOWS_STORE_PUBLISHER`, and `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME`, then dispatch **Package Microsoft Store app** from `main`. The workflow uploads the unsigned AppX as a temporary Actions artifact for submission to Partner Center; do not offer that unsigned AppX as a direct download.

Store versions use `major.minor.patch.beta` for prereleases and `major.minor.patch.65535` for the stable release. Increase the beta number for every Store submission under the same semantic version.

## Local artifact hygiene

Installers are large and reproducible, but deleting the only local copy is rarely useful. Archive a completed `release/` directory to a uniquely named sibling outside the worktree:

```sh
archive="../bordeaux-release-$(date +%Y%m%d-%H%M%S)"
test -d ./release && test ! -e "$archive" && mv ./release "$archive"
```

The command stops if `release/` is missing or the destination already exists. Restore a specific archive only into an empty destination:

```sh
archive="../bordeaux-release-YYYYMMDD-HHMMSS"
test -d "$archive" && test ! -e ./release && mv "$archive" ./release
```

`dist/`, `dist-electron/`, Java `build/` directories, and `node_modules/` are reproducible from the checked-in sources with `npm ci` and the build commands above. Keep them ignored; remove them only when rebuilding is acceptable.

Preview stale remote-tracking branches before pruning local references:

```sh
git remote prune origin --dry-run
git remote prune origin
```

This does not delete branches on the remote. Delete merged remote branches only through the repository's normal review workflow.

Do not remove `refs/t3/checkpoints/*` or `refs/codex/*` with raw Git commands. Those refs are recovery checkpoints owned by T3 Code and Codex; use the owning product's supported cleanup when one is available. `git gc` cannot reclaim objects retained by live checkpoint refs.
