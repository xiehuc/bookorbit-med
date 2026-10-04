#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
for tool in curl podman patch tar sha256sum gzip mktemp cp; do
  command -v "$tool" >/dev/null || { printf 'Missing required command: %s\n' "$tool" >&2; exit 1; }
done

upstream_commit=68bf37582ff512e9e10149f6247d15b54f3f7c5e
upstream_sha256=3d24ce25f3c16f856d3e6e8d82324a172cec84e5560d91fcc4606ee0937f33ce
upstream_url="https://github.com/bookorbit/bookorbit/archive/${upstream_commit}.tar.gz"
tag="${1:-localhost/bookorbit-med:68bf375-ocr1}"
case "$tag" in *[[:space:]]*) echo 'Image tag must not contain whitespace' >&2; exit 1 ;; esac
mkdir -p artifacts
work="$(mktemp -d "$PWD/.build.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT

curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 --silent --show-error \
  "$upstream_url" -o "$work/upstream.tar.gz"
printf '%s  %s\n' "$upstream_sha256" "$work/upstream.tar.gz" | sha256sum --check --status || {
  echo 'Upstream archive checksum mismatch' >&2
  exit 1
}
mkdir "$work/source"
tar -xzf "$work/upstream.tar.gz" -C "$work/source" --strip-components=1
patch --batch --fuzz=0 -d "$work/source" -p1 < 0001-ocr-integration.patch
cp -a overlay/. "$work/source/"

printf 'Building %s from upstream %s plus OCR patches\n' "$tag" "$upstream_commit"
podman build -f "$work/source/Dockerfile" -t "$tag" "$work/source"

safe_tag="$(printf '%s' "$tag" | tr '/:' '__')"
output="$PWD/artifacts/${safe_tag}.docker.tar.gz"
tmp_output="$work/image.docker.tar.gz"
podman save --format docker-archive "$tag" | gzip -1 > "$tmp_output"
mv -- "$tmp_output" "$output"
(cd artifacts && sha256sum "$(basename "$output")" > "$(basename "$output").sha256")
podman image inspect "$tag" --format 'Image={{.Id}} Architecture={{.Architecture}} Size={{.Size}}'
printf 'Archive: %s\nChecksum: %s\n' "$output" "${output}.sha256"
