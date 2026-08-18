#!/bin/sh
# Downscale public/images/dog-N.jpeg in place: cap the long edge at MAX px and
# re-encode as a progressive JPEG at QUALITY.
#
# Resizing uses macOS `sips` (built in). Encoding prefers `cjpeg` (libjpeg-turbo,
# `brew install jpeg-turbo`) because sips' own encoder is roughly 2x less efficient
# at equivalent visual quality; it falls back to sips when cjpeg is absent.
#
# Idempotent: images already within budget are skipped, and a re-encode that isn't
# smaller than the original is discarded. Originals remain in git history —
# `git checkout -- public/images` restores them.
set -e

MAX=${MAX:-2000}
QUALITY=${QUALITY:-80}
MAX_BYTES=${MAX_BYTES:-512000}
DIR="$(git rev-parse --show-toplevel)/public/images"

if command -v cjpeg >/dev/null 2>&1; then
  ENCODER=cjpeg
else
  ENCODER=sips
  echo "note: cjpeg not found, falling back to sips (larger files). brew install jpeg-turbo" >&2
fi

total_before=0
total_after=0

for f in "$DIR"/dog-*.jpeg; do
  name=$(basename "$f")
  w=$(sips -g pixelWidth "$f" | tail -1 | awk '{print $2}')
  h=$(sips -g pixelHeight "$f" | tail -1 | awk '{print $2}')
  long=$(( w > h ? w : h ))
  before=$(stat -f%z "$f")
  total_before=$(( total_before + before ))

  # Already within budget on both dimension and weight — leave it untouched.
  if [ "$long" -le "$MAX" ] && [ "$before" -le "$MAX_BYTES" ]; then
    echo "skip   $name (${w}x${h}, $((before/1024))KB)"
    total_after=$(( total_after + before ))
    continue
  fi

  tmp="$f.tmp.jpeg"
  if [ "$ENCODER" = cjpeg ]; then
    # sips resizes to an intermediate TGA (cjpeg cannot read sips' BMP output),
    # then cjpeg does the actual JPEG encoding.
    tga="$f.tmp.tga"
    sips -Z "$MAX" -s format tga "$f" --out "$tga" >/dev/null
    cjpeg -quality "$QUALITY" -progressive -optimize -outfile "$tmp" "$tga"
    rm -f "$tga"
  else
    sips -Z "$MAX" -s format jpeg -s formatOptions "$QUALITY" "$f" --out "$tmp" >/dev/null
  fi

  after=$(stat -f%z "$tmp")
  if [ "$after" -lt "$before" ]; then
    mv "$tmp" "$f"
    echo "shrink $name  $((before/1024))KB -> $((after/1024))KB"
    total_after=$(( total_after + after ))
  else
    rm -f "$tmp"
    echo "keep   $name (re-encode was no smaller)"
    total_after=$(( total_after + before ))
  fi
done

echo
echo "total: $((total_before/1048576))MB -> $((total_after/1048576))MB"
