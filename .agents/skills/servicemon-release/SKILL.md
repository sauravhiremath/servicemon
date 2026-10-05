---
name: servicemon-release
description: Publish a new Servicemon version and update its Homebrew tap through GitHub Actions, with checks between each step.
---

# Servicemon release

Use this skill when asked to release Servicemon. Read `docs/releasing.md` and both release workflows before acting.

## Before publication

- Require an approved version and permission to publish both the source release and tap update. Ask once if either is missing.
- Check GitHub access and that both repositories are public.
- Use a clean `master` checkout that matches `origin/master` after fetching branches and tags. Do not stash, discard, or commit unrelated changes.
- Check existing tags and releases. A new version must exceed the latest published version. Never replace published tags or assets.
- If the requested release exists, use its resolved tag commit as `SHA` and perform step 2's public-download checks. Then resume at the tap step. Do not bump or publish it again.
- Stop on failed checks, missing files, or mismatched versions or commits. Do not bypass a failed check.

## 1. Prepare the version

Set `VERSION` to the approved version. If the package already has that version, do not bump it again.

```sh
npm version "$VERSION" --no-git-tag-version
git add package.json package-lock.json
git commit -m "release: $VERSION"
git push origin master
```

Check that `package.json` and both root version fields in `package-lock.json` agree. Save the full pushed commit as `SHA`. Require successful **Source checks** for that exact commit before publication.

## 2. Publish the source

```sh
gh workflow run release.yml --repo sauravhiremath/servicemon \
  -f ref="$SHA" -F publish=true
```

Capture this dispatch's run ID. Watch that exact run, not the latest run:

```sh
gh run watch "$RUN_ID" --repo sauravhiremath/servicemon --exit-status
```

Require successful `candidate` and `publish` jobs; skipped publication is not success. Actions generates the release notes from commit messages.

Before updating the tap:

- Confirm `v$VERSION` resolves to `SHA` and the release is not a draft.
- Download the source archive, checksum, and manifest from the public release URLs without authentication.
- Require the manifest version and commit to match `VERSION` and `SHA`. Check the archive SHA-256 against both the manifest and checksum file.

## 3. Update the tap

```sh
gh workflow run tests.yml --repo sauravhiremath/homebrew-tap \
  -f version="$VERSION" -F publish=true
```

Watch this dispatch's exact run with `gh run watch "$RUN_ID" --repo sauravhiremath/homebrew-tap --exit-status`. Require successful `check` and `publish` jobs. If the run cannot be identified reliably, stop rather than guess.

Check the formula on tap `main`: its release URL and SHA-256 must match the verified source archive. Never start the tap update before the source download works.

## Finish

Report the version, source commit, release URL, both workflow results, and any manual coverage limits from `docs/releasing.md`. Do not count skipped checks as passed. Remove only temporary files created by this run. Do not install or restart the operator's normal services.
