#!/usr/bin/env bash
#
# deploy-spark001.sh — ship sparkDash to the spark001 production host.
#
# spark001 is a runtime box, not a checkout: it holds no .git, no frontend
# source and no node_modules. Everything it needs is built *here* and shipped as
# artifacts — exactly the paths the container bind-mounts. That is deliberate:
# the last time this was done by hand, files were scp'd into the root of a git
# checkout, the next `git pull` overwrote the real ones, and the FAEX1 halogen
# adaptation silently vanished. A one-way mirror from the repo removes the
# possibility of that class of loss.
#
#   ./scripts/deploy-spark001.sh              build + ship code and frontend
#   ./scripts/deploy-spark001.sh --image      also rebuild and ship the image
#   ./scripts/deploy-spark001.sh --rollback   restore the previous release
#   ./scripts/deploy-spark001.sh --dry-run    show what would change
#
# Dependencies (node_modules) live in the image, so --image is only needed when
# package-lock.json changes; the script says so when it detects that.
#
# Overridable: SPARK001_HOST, SPARK001_DIR, SPARKDASH_IMAGE_REPO,
# SPARKDASH_IMAGE_PLATFORM, RELEASES_KEEP.
set -euo pipefail

HOST="${SPARK001_HOST:-spark001}"
REMOTE_DIR="${SPARK001_DIR:-/home/spark001/sparkDash}"
IMAGE_REPO="${SPARKDASH_IMAGE_REPO:-sparkdash-sparkdash}"
IMAGE_PLATFORM="${SPARKDASH_IMAGE_PLATFORM:-linux/arm64}"
RELEASES_KEEP="${RELEASES_KEEP:-5}"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST")
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="deploy"
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --image) MODE="image" ;;
    --rollback) MODE="rollback" ;;
    --dry-run) MODE="dry-run" ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

# /api/* is bearer-gated whenever config/access-token exists — the server injects
# that file as SPARKDASH_TOKEN at boot. The probe reads it on the host, so the
# secret never travels back over the wire inside a response body.
verify_health() {
  local label="$1"
  local probe="curl -s -m 4 -H \"Authorization: Bearer \$(cat '$REMOTE_DIR/config/access-token' 2>/dev/null)\" http://127.0.0.1:5555/api/health"
  local _
  say "checking health"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if "${SSH[@]}" "$probe" 2>/dev/null | grep -q '"ok":true'; then
      say "spark001 is healthy ($label)"
      "${SSH[@]}" "cat '$REMOTE_DIR/DEPLOYED' 2>/dev/null" || true
      return 0
    fi
    sleep 3
  done
  die "health check did not pass — inspect: ssh $HOST 'cd $REMOTE_DIR && docker logs --tail 80 sparkDash'"
}

# The artifact set: what the container actually reads at runtime. `config/` is
# host state (sparks.json, secrets, bench history) and is never touched here.
ARTIFACT_DIRS=(dist server src/shared)
ARTIFACT_FILES=(docker-compose.yml src/components/ShowcasePage/showcasePrompts.ts)
# Test suites are source, not runtime: the production tree carries neither.
RSYNC_EXCLUDE=(--exclude='__tests__/' --exclude='*.test.js' --exclude='*.test.ts' --exclude='*.test.tsx')

cd "$REPO_ROOT"
command -v rsync >/dev/null || die "rsync is required on the deploying machine"

REV="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

"${SSH[@]}" "test -d '$REMOTE_DIR/config'" || die "$HOST:$REMOTE_DIR/config missing — wrong SPARK001_DIR?"

if [[ "$MODE" == "rollback" ]]; then
  say "rolling back to the previous release on $HOST"
  target="$("${SSH[@]}" "ls -1t '$REMOTE_DIR/.releases' 2>/dev/null | sed -n 2p")"
  [[ -n "$target" ]] || die "no previous release in $REMOTE_DIR/.releases"
  # Sync in place instead of deleting first: `dist`, `server` and `src/shared` are
  # bind-mounted into the running container, and a directory that is unlinked and
  # recreated leaves the container holding the old inode — an empty mount and a
  # MODULE_NOT_FOUND crash that only a recreate would heal.
  "${SSH[@]}" bash -s -- "$REMOTE_DIR" "$target" <<'REMOTE'
set -e
dir="$1"; target="$2"
rel="$dir/.releases/$target"
for needed in dist server shared; do
  [ -d "$rel/$needed" ] || { echo "release $target is incomplete (no $needed) — refusing" >&2; exit 1; }
done
cd "$dir"
mkdir -p src src/components/ShowcasePage
rsync -a --delete "$rel/dist/" dist/
rsync -a --delete "$rel/server/" server/
rsync -a --delete "$rel/shared/" src/shared/
[ -f "$rel/showcasePrompts.ts" ] && cp "$rel/showcasePrompts.ts" src/components/ShowcasePage/showcasePrompts.ts
[ -f "$rel/docker-compose.yml" ] && cp "$rel/docker-compose.yml" docker-compose.yml
printf 'rolled back to %s at %s\n' "$target" "$(date -u +%FT%TZ)" > DEPLOYED
REMOTE
  say "restarting to pick the old code back up"
  "${SSH[@]}" "cd '$REMOTE_DIR' && docker compose up -d --no-build"
  verify_health "rollback to $target"
  exit 0
fi

if [[ "$MODE" != "dry-run" && "$SKIP_BUILD" == "0" ]]; then
  say "building the frontend (vite)"
  npm run build --silent
fi

say "deploying rev $REV to $HOST:$REMOTE_DIR"
for path in "${ARTIFACT_DIRS[@]}" "${ARTIFACT_FILES[@]}"; do
  [[ -e "$path" ]] || die "$path is missing locally — run npm run build?"
done

rsync_flags=(-rlpt --delete --delete-excluded)
[[ "$MODE" == "dry-run" ]] && rsync_flags+=(--dry-run --itemize-changes)

# Snapshot what is running now so --rollback has something to go back to. The
# release dir carries the same shape as the artifact set.
if [[ "$MODE" == "deploy" || "$MODE" == "image" ]]; then
  say "snapshotting the running release as .releases/$STAMP"
  # A snapshot missing any mounted path is not restorable, so refuse to record one
  # rather than keep a release that --rollback would trip over later.
  "${SSH[@]}" bash -s -- "$REMOTE_DIR" "$STAMP" "$RELEASES_KEEP" <<'REMOTE'
set -e
dir="$1"; stamp="$2"; keep="$3"
cd "$dir"
for needed in dist server src/shared; do
  [ -d "$needed" ] || { echo "running tree has no $needed — skipping snapshot" >&2; exit 1; }
done
rel=".releases/$stamp"
mkdir -p "$rel"
cp -a dist "$rel/dist"
cp -a server "$rel/server"
cp -a src/shared "$rel/shared"
cp src/components/ShowcasePage/showcasePrompts.ts "$rel/" 2>/dev/null || true
cp docker-compose.yml "$rel/" 2>/dev/null || true
cd .releases && ls -1t | tail -n +$((keep + 1)) | xargs -r rm -rf
REMOTE
fi

# rsync creates only the last component of a destination path, and the macOS
# rsync here is too old for --mkpath, so lay the parents down first.
"${SSH[@]}" "mkdir -p '$REMOTE_DIR/src/components/ShowcasePage'"

for dir in "${ARTIFACT_DIRS[@]}"; do
  say "sync $dir/"
  rsync "${rsync_flags[@]}" "${RSYNC_EXCLUDE[@]}" "$dir/" "$HOST:$REMOTE_DIR/$dir/"
done
for file in "${ARTIFACT_FILES[@]}"; do
  say "sync $file"
  rsync "${rsync_flags[@]}" --no-times "$file" "$HOST:$REMOTE_DIR/$file"
done

if [[ "$MODE" == "dry-run" ]]; then
  say "dry run finished — nothing changed"
  exit 0
fi

# The image only has to move when the dependency set does; say so instead of
# letting a stale node_modules fail mysteriously at runtime.
if [[ "$MODE" == "image" ]]; then
  say "building $IMAGE_REPO:latest for $IMAGE_PLATFORM and shipping the image"
  docker buildx build --platform "$IMAGE_PLATFORM" -t "$IMAGE_REPO:latest" -t "$IMAGE_REPO:$REV" --load .
  docker save "$IMAGE_REPO:latest" "$IMAGE_REPO:$REV" | "${SSH[@]}" "docker load"
else
  deployed_lock="$("${SSH[@]}" "sha256sum '$REMOTE_DIR/package-lock.json' 2>/dev/null | cut -c1-16" || true)"
  local_lock="$( (sha256sum package-lock.json 2>/dev/null || shasum -a 256 package-lock.json) | cut -c1-16)"
  if [[ -n "$deployed_lock" && "$deployed_lock" != "$local_lock" ]]; then
    say "package-lock.json differs from what the image was built with — run: $0 --image"
  fi
  rsync "${rsync_flags[@]}" package.json package-lock.json "$HOST:$REMOTE_DIR/"
fi

printf 'rev=%s stamp=%s mode=%s\n' "$REV" "$STAMP" "$MODE" |
  "${SSH[@]}" "cat > '$REMOTE_DIR/DEPLOYED'"

say "reconciling the container (node --watch already reloads ./server)"
"${SSH[@]}" "cd '$REMOTE_DIR' && docker compose up -d --no-build"

verify_health "rev $REV"
