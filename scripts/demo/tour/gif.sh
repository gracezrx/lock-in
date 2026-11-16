#!/usr/bin/env bash
# The README's GIF: a ~25-second silent cut of the tour, the big moment of each chapter, no
# subtitles (the chapter titles carry it). Renders the tour without subtitles first.
#   bash scripts/demo/tour/gif.sh        -> docs/tour.gif
set -euo pipefail
cd "$(dirname "$0")/../../.."
SRC=release/tour-nosubs.mp4
if [ ! -f "$SRC" ]; then
  node scripts/demo/launch/record.mjs --film tour --nosubs --fps 30 --sub 1 --out "$SRC" --work release/tour-nosubs-work
fi
# [from, to] in tour time: the open, the escalation, talking back, mom, to-dos, routines,
# calendar, the bomb, everywhere, the end card.
SEGS=(
  "0.5 3.7"
  "22.15 23.3" "23.7 25.0" "29.95 31.2" "31.4 32.7" "33.1 34.6"
  "37.5 40.2"
  "47.8 49.7"
  "52.6 53.6" "54.6 56.2"
  "59.2 60.3" "61.6 62.8"
  "64.6 65.9"
  "70.6 72.4"
  "75.1 78.6"
  "81.8 84.6"
)
# Each piece on its own (one ffmpeg per piece keeps memory small), then joined, then a palette
# and the GIF.
TMP=release/tour-gif-work
rm -rf "$TMP" && mkdir -p "$TMP"
i=0
for s in "${SEGS[@]}"; do
  read -r a b <<<"$s"
  ffmpeg -y -loglevel error -ss "$a" -to "$b" -i "$SRC" -vf "fps=10,scale=840:-1:flags=lanczos" -an -c:v libx264 -crf 12 -preset fast -pix_fmt yuv444p "$TMP/$(printf %02d $i).mp4"
  echo "file '$(printf %02d $i).mp4'" >>"$TMP/list.txt"
  i=$((i + 1))
done
ffmpeg -y -loglevel error -f concat -safe 0 -i "$TMP/list.txt" -c copy "$TMP/cut.mp4"
ffmpeg -y -loglevel error -i "$TMP/cut.mp4" -vf "palettegen=max_colors=128:stats_mode=diff" "$TMP/palette.png"
ffmpeg -y -loglevel error -i "$TMP/cut.mp4" -i "$TMP/palette.png" -lavfi "paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" docs/tour.gif
ls -la docs/tour.gif
