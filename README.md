# BookOrbit OCR custom build

This is a modified BookOrbit build, not an official release. The base is pinned to upstream Git commit `68bf37582ff512e9e10149f6247d15b54f3f7c5e`. The build script downloads that commit's source tarball from GitHub on **each build** and checks its SHA256; there is no committed upstream archive. The tarball is only used as a build input, not as the format for our changes.

## Files to commit

- `0001-ocr-integration.patch`: edits to ten existing upstream files.
- `overlay/`: 146 **ordinary files** added for OCR, migrations, tests, docs and the BookReader vendor assets. Review with `git diff --cached -- overlay/` after staging, and edit these files directly for future changes.
- `build-image.sh`: download pinned upstream, verify checksum, apply patch without fuzz, copy the overlay, build the production Dockerfile with Podman, and save a Docker-compatible compressed image archive with checksum.
- `.gitignore`: excludes generated image archives, logs, old tar bundles and temporary directories.

The replayed source was checked byte-for-byte against all 156 intended files of the tested checkout. The overlay contains no patient CBZ, OCR JSON sidecar, development secrets, installed dependencies or validation data. Original patient CBZ and adjacent JSON are runtime data; mount them from protected storage. Do not embed or publish patient data in the image.

## Build

Run `./build-image.sh` from this directory, or pass an optional image tag. Default tag: `localhost/bookorbit-med:68bf375-ocr1`. Requires `curl`, `patch`, `tar`, `sha256sum`, `gzip`, `cp` and `podman`, network access to GitHub and the base/package registries, and enough disk space. Pin changes to upstream commit and update its archive checksum **together**, then regenerate/test the patch before building.

The output is `artifacts/localhost_bookorbit-med_68bf375-ocr1.docker.tar.gz` with `.sha256`; neither is intended for Git. On a destination host, copy both files, run `sha256sum -c <archive>.sha256` in their directory, then `gzip -dc <archive> | podman load`. This is an amd64 build on the current host, not a multi-architecture image. The script does not stop or restart any running container.

## Deployment and registry

Use a **private** GHCR package if you later publish this image; select its namespace and access controls before pushing. The source/patches are a separate distribution concern: preserve BookOrbit and BookReader licenses and attribution, and review AGPL network-source and BookOrbit additional terms before a release. No registry push is performed by this script. Back up the production database before applying the generated OCR migrations 0099 and 0100. Keep secrets in runtime environment files and patient books in protected runtime mounts. The production Dockerfile's healthcheck can be lost when Podman builds in OCI format, so probe `GET /api/v1/health` explicitly.
