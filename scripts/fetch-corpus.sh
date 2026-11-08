#!/usr/bin/env bash
# Materialise the real-world G-code corpus used by server/test/corpus-tests.
#
# The corpus is Vision Miner's 22IDEX V4 SD-card firmware at a PINNED commit of branch
# release/4.2.0 (4.2.0 is not tagged as a release yet; the only tag is 4.2.0-rc.1).
# It is proprietary and this repository is public, so it is NEVER committed:
# the target directory is gitignored and the corpus tests skip when it is absent.
#
# Usage: scripts/fetch-corpus.sh [path-to-vm22-v4-firmware]
set -euo pipefail

SRC="${1:-/home/remenod/VisionMiner/firmware/vm22-v4-firmware}"
SHA="bfdc95eb2325039b9a63c8c78794c2a2ab87c771"
DEST="$(cd "$(dirname "$0")/.." && pwd)/server/test/corpus/vm22-v4"

git -C "$SRC" cat-file -e "$SHA^{commit}" || { echo "commit $SHA not found in $SRC" >&2; exit 1; }
rm -rf "$DEST"
mkdir -p "$DEST"
git -C "$SRC" archive "$SHA" | tar -x -C "$DEST"
echo "$SHA" > "$DEST/.corpus-sha"
echo "corpus at $SHA -> $DEST ($(find "$DEST" -type f | wc -l) files)"
