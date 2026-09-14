#!/usr/bin/env bash
#
# Rebases the fork's patches onto the latest upstream release.
#
# Does the mechanical part only: finds the release, replays the patches, stops
# at the first conflict and leaves the rebase in progress for you to resolve.
# It never pushes, never force-pushes, and never touches main.
#
# Usage:
#   qr/sync-upstream.sh              # onto the newest twenty/vX.Y.Z
#   qr/sync-upstream.sh twenty/v2.41.0
#   qr/sync-upstream.sh --list       # what is available, and where we are

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

UPSTREAM_URL=https://github.com/twentyhq/twenty.git

note() { printf '\033[36m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# The fork tracks upstream *releases*, not upstream main: a release tag is a
# point upstream has run its own full CI against, which is most of the
# confidence the fork gets for free.
latest_release() {
  git tag -l 'twenty/v*' --sort=-v:refname \
    | grep -v -- '-' \
    | head -n1
}

# Every commit on this branch that upstream does not have. Merge commits are
# excluded because rebase drops them anyway — they are PR merges of the very
# commits listed here.
fork_patches() {
  git log --oneline --no-merges HEAD --not upstream/main
}

if ! git remote get-url upstream >/dev/null 2>&1; then
  note "adding the upstream remote"
  git remote add upstream "$UPSTREAM_URL"
fi

note "fetching upstream (this pulls ~a thousand commits after a few weeks)"
git fetch --quiet upstream --tags

target=${1:-$(latest_release)}

if [ "$target" = "--list" ]; then
  echo
  echo "Recent upstream releases:"
  git tag -l 'twenty/v*' --sort=-v:refname | grep -v -- '-' | head -n8 | sed 's/^/  /'
  echo
  echo "This branch is based on:"
  printf '  %s\n' "$(git describe --tags --abbrev=0 --match 'twenty/v*' HEAD 2>/dev/null || echo 'unknown')"
  echo
  echo "Fork patches that would be replayed:"
  fork_patches | sed 's/^/  /'
  echo
  exit 0
fi

git rev-parse --verify "$target" >/dev/null 2>&1 \
  || die "no such tag: $target"

[ -z "$(git status --porcelain)" ] \
  || die "working tree is dirty — commit or stash first"

base=$(git merge-base HEAD upstream/main)
branch="qr-sync-upstream-${target#twenty/v}"

git rev-parse --verify "$branch" >/dev/null 2>&1 \
  && die "branch $branch already exists — delete it or pass a different target"

echo
note "target:   $target"
note "base:     $(git log --oneline -1 "$base")"
note "branch:   $branch"
echo
echo "Patches to replay:"
fork_patches | sed 's/^/  /'
echo

git checkout -q -b "$branch"

if git rebase --onto "$target" "$base" "$branch"; then
  echo
  note "rebase clean. Now, in order:"
  echo "  1. qr/verify-patches.sh            # patches still reach their call sites"
  echo "  2. yarn nx build twenty-shared     # before any typecheck is trustworthy"
  echo "  3. cd packages/twenty-server && npx tsgo -p tsconfig.json --noEmit"
  echo "  4. yarn nx lint twenty-server"
  echo "  5. npx jest --config=packages/twenty-server/jest.config.mjs"
  echo
  echo "Then open a PR against main. See qr/README.md for the deploy that follows."
  exit 0
fi

echo
note "rebase stopped on a conflict — this is normal, resolve and continue:"
echo "  git status                   # what is conflicted"
echo "  git rebase --continue"
echo
echo "Resolving well matters more than resolving fast. A patch whose call site"
echo "upstream *moved* conflicts cleanly at the old location and silently loses"
echo "its effect — qr/verify-patches.sh is what catches that. Read qr/README.md."
exit 1
