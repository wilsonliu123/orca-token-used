#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/publish-plugin.sh <version> [--dry-run]

Examples:
  scripts/publish-plugin.sh 0.1.1
  scripts/publish-plugin.sh 0.1.1 --dry-run
USAGE
}

VERSION_INPUT=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$VERSION_INPUT" ]]; then
        echo "Only one version is allowed." >&2
        usage >&2
        exit 2
      fi
      VERSION_INPUT="$arg"
      ;;
  esac
done

if [[ -z "$VERSION_INPUT" ]]; then
  usage >&2
  exit 2
fi

VERSION="${VERSION_INPUT#v}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid semver: $VERSION_INPUT" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Release must run from the main branch." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "The origin remote is required." >&2
  exit 1
fi

git fetch origin main --quiet
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "Local main is behind or diverged from origin/main. Reconcile it first." >&2
  exit 1
fi

while IFS= read -r line; do
  path="${line:3}"
  case "$path" in
    README.md|LICENSE|CHANGELOG.md|orca-plugin.json|tsconfig.json|token-pulse-plan.md|.gitignore|assets/*|docs/*|scripts/*|src/*) ;;
    *)
      echo "Unexpected worktree change: $path" >&2
      echo "Commit or remove it before publishing." >&2
      exit 1
      ;;
  esac
done < <(git status --porcelain)

CURRENT_VERSION="$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('orca-plugin.json','utf8')).version)")"

TAG="v$VERSION"
if git show-ref --tags --verify --quiet "refs/tags/$TAG"; then
  echo "Tag $TAG already exists locally." >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists on origin." >&2
  exit 1
fi

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
VISIBILITY="$(gh repo view --json visibility -q .visibility)"
if [[ "$VISIBILITY" != "PUBLIC" ]]; then
  echo "$REPO must be public before publishing." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI authentication is required." >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: would publish $REPO as $TAG"
  echo "Dry run: would update orca-plugin.json from $CURRENT_VERSION to $VERSION"
  echo "Dry run: would run orca plugin validate ."
  echo "Dry run: would run orca plugin test ."
  echo "Dry run: would commit, push main, create $TAG, and push $TAG"
  echo "Dry run: would ensure the repository has the orca-plugin topic"
  exit 0
fi

if [[ "$CURRENT_VERSION" != "$VERSION" ]]; then
  node - "$VERSION" <<'NODE'
  const fs = require('fs')
  const version = process.argv[2]
  const path = 'orca-plugin.json'
  const manifest = JSON.parse(fs.readFileSync(path, 'utf8'))
  manifest.version = version
  fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
NODE
fi

orca plugin validate .
orca plugin test .

TOPICS="$(gh repo view --json repositoryTopics -q '(.repositoryTopics // []) | map(.name) | join(" ")')"
if [[ " $TOPICS " != *" orca-plugin "* ]]; then
  gh repo edit "$REPO" --add-topic orca-plugin
fi

git add -A -- README.md LICENSE orca-plugin.json tsconfig.json token-pulse-plan.md .gitignore assets docs scripts src
if git diff --cached --quiet; then
  echo "No release changes to commit." >&2
  exit 1
fi

git commit -m "release: $TAG"
git push origin main
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"

echo
echo "Published $REPO $TAG"
echo "Directory: https://www.onorca.dev/plugins/${REPO}"
echo "Install:   orca plugin install ${REPO}@${TAG}"
