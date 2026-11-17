#!/bin/sh
# Installs the font set of the hmcts/rdo-docmosis image (Fedora 40 plus LibreOffice 7.6.7.2) under the given
# directory. Every download is pinned in sources.sha256 and every installed font is checked against fonts.sha256,
# which was taken from the running Docmosis image, so a changed upstream file fails the build.
#
# Book Antiqua is not downloaded: the Dockerfile copies it from the Docmosis image into the output directory before
# this script runs, and the checks below cover it like every other font.
set -eu

out=$1
here=$(cd "$(dirname "$0")" && pwd)

dl=$(mktemp -d)
work=$(mktemp -d)
trap 'rm -rf "$dl" "$work"' EXIT

sf=https://downloads.sourceforge.net
fedora=https://archives.fedoraproject.org/pub/archive/fedora/linux/releases/40/Everything/x86_64/os/Packages
lo=https://downloadarchive.documentfoundation.org/libreoffice/old/7.6.7.2/rpm/x86_64/LibreOffice_7.6.7.2_Linux_x86-64_rpm.tar.gz

fetch() {
  curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o "$dl/$2" "$1"
}

for cab in andale32.exe arialb32.exe comic32.exe courie32.exe georgi32.exe impact32.exe webdin32.exe wd97vwr32.exe; do
  fetch "$sf/corefonts/$cab" "$cab"
done
fetch "$sf/mscorefonts2/EUupdate.EXE" EUupdate.EXE
fetch "$sf/mscorefonts2/PowerPointViewer.exe" PowerPointViewer.exe

for rpm in \
  a/abattis-cantarell-vf-fonts-0.301-12.fc40.noarch.rpm \
  a/adobe-source-code-pro-fonts-2.042.1.062.1.026-4.fc40.noarch.rpm \
  g/gnu-free-mono-fonts-20120503-33.fc40.noarch.rpm \
  g/gnu-free-sans-fonts-20120503-33.fc40.noarch.rpm \
  g/gnu-free-serif-fonts-20120503-33.fc40.noarch.rpm \
  g/google-noto-sans-vf-fonts-20240301-2.fc40.noarch.rpm \
  o/open-sans-fonts-1.10-21.fc40.noarch.rpm \
  x/xorg-x11-fonts-Type1-7.5-38.fc40.noarch.rpm; do
  fetch "$fedora/$rpm" "$(basename "$rpm")"
done
fetch "$lo" LO.tar.gz

(cd "$dl" && sha256sum -c "$here/sources.sha256")

ms=$out/usr/share/fonts/msttcore
mkdir -p "$ms"

# The same extraction as msttcore-fonts-installer's refresh-msttcore-fonts.sh.
for cab in andale32.exe arialb32.exe comic32.exe courie32.exe georgi32.exe impact32.exe webdin32.exe EUupdate.EXE; do
  cabextract --lowercase -q -F '*.ttf' --directory="$ms" "$dl/$cab"
done

# Tahoma is inside the Word 97 viewer.
cabextract --lowercase -q -F viewer1.cab --directory="$work" "$dl/wd97vwr32.exe"
cabextract --lowercase -q -F '*.ttf' --directory="$ms" "$work/viewer1.cab"

# Calibri, Cambria, Candara, Consolas, Constantia, Corbel and Tahoma come from the PowerPoint viewer, and so does
# cambria.ttc, which the installer does not extract.
cabextract --lowercase -q -F ppviewer.cab --directory="$work" "$dl/PowerPointViewer.exe"
cabextract --lowercase -q -F '*.ttf' --directory="$ms" "$work/ppviewer.cab"
cabextract --lowercase -q -F '*.ttc' --directory="$ms" "$work/ppviewer.cab"

# Fedora's font packages bring their own fontconfig rules, which are what make Segoe UI resolve to Cantarell and
# unknown families to Noto Sans on Docmosis.
for rpm in "$dl"/*.rpm; do
  bsdtar -xf "$rpm" -C "$out" --no-same-owner
done
rm -rf "$out/usr/share/doc" "$out/usr/share/licenses"

# LibreOffice finds these in its own share/fonts/truetype and fontconfig never lists them, as on Docmosis.
tar -xzf "$dl/LO.tar.gz" -C "$work" LibreOffice_7.6.7.2_Linux_x86-64_rpm/RPMS/libobasis7.6-ooofonts-7.6.7.2-2.x86_64.rpm
mkdir "$work/lo"
bsdtar -xf "$work"/LibreOffice_*/RPMS/libobasis7.6-ooofonts-*.rpm -C "$work/lo" --no-same-owner
lofonts=$out/usr/lib/libreoffice/share/fonts/truetype
mkdir -p "$lofonts"
mv "$work"/lo/opt/libreoffice7.6/share/fonts/truetype/* "$lofonts/"

cd "$out"
sha256sum -c "$here/fonts.sha256"

# sha256sum -c cannot see extra files, so compare the file lists as well.
find usr/share/fonts usr/share/X11/fonts usr/lib/libreoffice/share/fonts -type f ! -name fonts.dir ! -name fonts.scale | sort > "$work/installed"
sed 's/^[0-9a-f]*  //' "$here/fonts.sha256" | sort > "$work/expected"
diff "$work/expected" "$work/installed"
