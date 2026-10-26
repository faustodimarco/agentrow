#!/usr/bin/env bash
# Build agentrow for every supported platform and publish a GitHub release.
#   scripts/release.sh            # version from package.json
# Requires: bun, gh (logged in), a clean tree pushed to origin.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
TAG="v$VERSION"
TARGETS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "release: working tree has uncommitted changes" >&2
  exit 1
fi
git push --quiet origin HEAD
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "release: $TAG already exists; bump the version in package.json" >&2
  exit 1
fi

rm -rf dist && mkdir -p dist
for target in "${TARGETS[@]}"; do
  echo "building $target"
  bun build src/cli.ts --compile --minify --target="bun-$target" --outfile "dist/$target/agentrow" >/dev/null
  tar -C "dist/$target" -czf "dist/agentrow-$target.tar.gz" agentrow
done
(cd dist && shasum -a 256 agentrow-*.tar.gz > SHA256SUMS)

gh release create "$TAG" dist/agentrow-*.tar.gz dist/SHA256SUMS install.sh install.ps1 \
  --target "$(git rev-parse HEAD)" --title "agentrow $TAG" --generate-notes
