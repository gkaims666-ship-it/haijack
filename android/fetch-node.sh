#!/usr/bin/env bash
# Скачивает nodejs-mobile (Node.js как библиотека для Android) в app/libnode.
# Использование: bash android/fetch-node.sh
set -euo pipefail

VERSION="${NODEJS_MOBILE_VERSION:-v18.20.4}"
cd "$(dirname "$0")/app"

if [ -f libnode/bin/arm64-v8a/libnode.so ] && [ -f libnode/include/node/node.h ]; then
  echo "libnode уже на месте"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

url="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VERSION}/nodejs-mobile-${VERSION}-android.zip"
echo "Скачиваю $url"
curl --fail --location --retry 3 --silent --show-error -o "$tmp/node.zip" "$url"
unzip -q "$tmp/node.zip" -d "$tmp/unpacked"

# Раскладка архива менялась между версиями, поэтому ищем нужное по именам файлов
so="$(find "$tmp/unpacked" -path '*arm64-v8a/libnode.so' | head -n 1)"
header="$(find "$tmp/unpacked" -path '*include/node/node.h' | head -n 1)"
if [ -z "$so" ] || [ -z "$header" ]; then
  echo "В архиве не найдены libnode.so или node.h. Содержимое:" >&2
  find "$tmp/unpacked" -maxdepth 4 | head -n 60 >&2
  exit 1
fi

bin_dir="$(dirname "$(dirname "$so")")"
include_dir="$(dirname "$(dirname "$header")")"

rm -rf libnode
mkdir -p libnode
cp -r "$bin_dir" libnode/bin
cp -r "$include_dir" libnode/include

for abi in arm64-v8a armeabi-v7a x86_64; do
  test -f "libnode/bin/$abi/libnode.so" || { echo "Нет libnode.so для $abi" >&2; exit 1; }
done
echo "libnode ${VERSION} готов:"
ls -la libnode/bin/*/libnode.so
