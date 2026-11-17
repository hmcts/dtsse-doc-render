#!/bin/bash
# For every <dir>/<id>/ holding a.pdf (Docmosis) and b.pdf (dtsse-doc-render): rasterise at 100 dpi, diff each page,
# and dump fonts and text boxes. Writes beside the inputs; the caller copies the tree out.
FUZZ="${FUZZ:-12%}"
cd "${1:-/work}" || exit 2
for dir in */; do
  id="${dir%/}"
  (
    cd "$id" || exit
    for side in a b; do
      [ -f "$side.pdf" ] || continue
      pdffonts "$side.pdf" >"$side.fonts" 2>&1
      pdfimages -list "$side.pdf" >"$side.images" 2>&1
      pdftotext -bbox-layout "$side.pdf" "$side.html" 2>/dev/null
      pdftoppm -r 100 -png "$side.pdf" "$side" 2>/dev/null
    done
    : >metrics.tsv
    for f in a-*.png; do
      [ -e "$f" ] || continue
      n="${f#a-}"; n="${n%.png}"
      pa="a-$n.png"; pb="b-$n.png"
      if [ ! -f "$pb" ]; then
        continue
      fi
      w=$(magick identify -format '%w\n' "$pa" "$pb" | sort -n | tail -1)
      h=$(magick identify -format '%h\n' "$pa" "$pb" | sort -n | tail -1)
      magick "$pa" -background white -gravity northwest -extent "${w}x${h}" -alpha off "na-$n.png"
      magick "$pb" -background white -gravity northwest -extent "${w}x${h}" -alpha off "nb-$n.png"
      ae=$(magick compare -fuzz "$FUZZ" -metric AE -highlight-color red -lowlight-color '#e8e8e8' "na-$n.png" "nb-$n.png" "d-$n.png" 2>&1 | awk '{print $1}')
      inka=$(magick "na-$n.png" -colorspace Gray -threshold 90% -format '%[fx:(1-mean)*w*h]' info:)
      inkb=$(magick "nb-$n.png" -colorspace Gray -threshold 90% -format '%[fx:(1-mean)*w*h]' info:)
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$ae" "$((w*h))" "${inka%.*}" "${inkb%.*}" "${w}x${h}" >>metrics.tsv
      rm -f "na-$n.png" "nb-$n.png"
    done
  )
done
