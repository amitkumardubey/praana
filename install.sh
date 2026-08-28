#!/bin/sh
# PRAANA installer — POSIX sh, no Bun/Node required.
#
#   curl -fsSL https://raw.githubusercontent.com/amitkumardubey/praana/main/install.sh | sh
#
# Downloads the matching GitHub Release archive, verifies SHA256SUMS, and
# installs `praana`, `praana-natives.node`, and `praana-natives.json` into
# ~/.local/bin (or /usr/local/bin when root). Keep these files in the same directory.
set -eu

RELEASE_BASE_DEFAULT="https://github.com/amitkumardubey/praana/releases/latest/download"
SIDECAR_NAME="praana-natives.node"
MANIFEST_NAME="praana-natives.json"

usage() {
  cat <<'EOF'
Install PRAANA from GitHub Releases (no Bun required).

Usage:
  install.sh [--prefix DIR] [--print-target]

Options:
  --prefix DIR     Install into DIR (default: ~/.local/bin, or /usr/local/bin if root)
  --print-target   Print archive stem (e.g. praana-linux-x64) and exit
  -h, --help       Show this help

Environment:
  PRAANA_UNAME_S / PRAANA_UNAME_M   Override uname -s / uname -m (tests)
  PRAANA_LIBC                       Override libc: gnu | musl (tests)
  PRAANA_RELEASE_BASE               Override download base URL (tests / mirrors)
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "install.sh requires '$1' on PATH"
}

detect_libc() {
  if [ -n "${PRAANA_LIBC:-}" ]; then
    printf '%s\n' "$PRAANA_LIBC"
    return
  fi
  if [ -f /etc/alpine-release ]; then
    printf '%s\n' musl
    return
  fi
  if command -v ldd >/dev/null 2>&1; then
    if ldd /bin/sh 2>/dev/null | grep musl >/dev/null 2>&1; then
      printf '%s\n' musl
      return
    fi
  fi
  printf '%s\n' gnu
}

# Prints archive stem (praana-linux-x64) or dies with "unsupported".
detect_target() {
  os=${PRAANA_UNAME_S:-$(uname -s)}
  machine=${PRAANA_UNAME_M:-$(uname -m)}

  case "$os" in
    Linux | linux) os_name=linux ;;
    Darwin | darwin) os_name=darwin ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      die "unsupported: use install.ps1 on Windows (PowerShell). See README."
      ;;
    *)
      die "unsupported: OS '$os'"
      ;;
  esac

  case "$machine" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    i386 | i686 | armv7* | armv6*)
      die "unsupported: architecture '$machine' (32-bit is not shipped)"
      ;;
    *)
      die "unsupported: architecture '$machine'"
      ;;
  esac

  if [ "$os_name" = linux ]; then
    libc=$(detect_libc)
    if [ "$libc" = musl ]; then
      die "unsupported: Linux musl (Alpine). Use: bun add -g praana"
    fi
  fi

  printf '%s\n' "praana-${os_name}-${arch}"
}

file_sha256() {
  path=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{ print $1 }'
  else
    die "install.sh requires sha256sum or shasum"
  fi
}

expected_sha256() {
  sums=$1
  filename=$2
  awk -v f="$filename" '$2 == f { print $1; found=1 } END { exit found ? 0 : 1 }' "$sums"
}

path_has_dir() {
  dir=$1
  case ":${PATH}:" in
    *":${dir}:"*) return 0 ;;
    *) return 1 ;;
  esac
}

print_target=0
prefix=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --print-target)
      print_target=1
      shift
      ;;
    --prefix)
      [ $# -ge 2 ] || die "--prefix requires a directory"
      prefix=$2
      shift 2
      ;;
    --prefix=*)
      prefix=${1#--prefix=}
      [ -n "$prefix" ] || die "--prefix requires a directory"
      shift
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

target=$(detect_target)
archive="${target}.tar.gz"

if [ "$print_target" -eq 1 ]; then
  printf '%s\n' "$target"
  exit 0
fi

need_cmd curl
need_cmd tar
need_cmd awk
need_cmd grep

base=${PRAANA_RELEASE_BASE:-$RELEASE_BASE_DEFAULT}
# Trim trailing slash
case "$base" in
  */) base=${base%/} ;;
esac

if [ -n "$prefix" ]; then
  dest=$prefix
elif [ "$(id -u)" -eq 0 ]; then
  dest=/usr/local/bin
else
  dest="${HOME}/.local/bin"
fi

tmpdir=$(mktemp -d)
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT INT TERM

printf 'Downloading %s …\n' "$archive" >&2
if ! curl -fsSL -A praana-install -o "$tmpdir/SHA256SUMS" "$base/SHA256SUMS"; then
  die "failed to download SHA256SUMS from $base (no archive on latest release yet?)"
fi
if ! curl -fsSL -A praana-install -o "$tmpdir/$archive" "$base/$archive"; then
  die "failed to download $archive from $base (no archive on latest release yet?)"
fi

if ! expected=$(expected_sha256 "$tmpdir/SHA256SUMS" "$archive"); then
  die "SHA256SUMS has no entry for $archive"
fi
actual=$(file_sha256 "$tmpdir/$archive")
if [ "$expected" != "$actual" ]; then
  die "checksum mismatch for $archive: expected $expected got $actual"
fi

mkdir -p "$tmpdir/extract"
tar -xzf "$tmpdir/$archive" -C "$tmpdir/extract"
[ -f "$tmpdir/extract/praana" ] || die "archive missing praana"
[ -f "$tmpdir/extract/$SIDECAR_NAME" ] || die "archive missing $SIDECAR_NAME (native sidecar)"

mkdir -p "$dest"
stage=$(mktemp -d "$dest/.praana-install.XXXXXX")
cp "$tmpdir/extract/praana" "$stage/praana"
cp "$tmpdir/extract/$SIDECAR_NAME" "$stage/$SIDECAR_NAME"
if [ -f "$tmpdir/extract/$MANIFEST_NAME" ]; then
  cp "$tmpdir/extract/$MANIFEST_NAME" "$stage/$MANIFEST_NAME"
fi
chmod +x "$stage/praana"
mv -f "$stage/praana" "$dest/praana"
mv -f "$stage/$SIDECAR_NAME" "$dest/$SIDECAR_NAME"
if [ -f "$stage/$MANIFEST_NAME" ]; then
  mv -f "$stage/$MANIFEST_NAME" "$dest/$MANIFEST_NAME"
fi
rmdir "$stage" 2>/dev/null || rm -rf "$stage"

printf 'Installed %s and %s to %s\n' praana "$SIDECAR_NAME" "$dest"
if ! path_has_dir "$dest"; then
  printf '\n%s is not on PATH. Add:\n  export PATH="%s:$PATH"\n' "$dest" "$dest"
fi
if ! "$dest/praana" --version >/dev/null 2>&1; then
  die "smoke --version failed after install"
fi
doc_out=$("$dest/praana" doctor 2>&1) || true
if ! printf '%s\n' "$doc_out" | grep '✓ native:' >/dev/null; then
  printf '%s\n' "$doc_out" >&2
  die "doctor did not report native capability"
fi
if ! printf '%s\n' "$doc_out" | grep '✓ search:' >/dev/null; then
  printf '%s\n' "$doc_out" >&2
  die "doctor did not report search capability"
fi
printf 'Run: praana --version\n'
