#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
OUT="$ROOT/insta-analytics-chrome-store-v5.6.0.zip"
TMP="$ROOT/.store-build-v5.6"

rm -rf "$TMP"
rm -f "$OUT"
mkdir -p "$TMP"

cp "$EXT/manifest.json" "$TMP/manifest.json"
cp -R "$EXT/src" "$TMP/src"
cp -R "$EXT/icons" "$TMP/icons"

if find "$TMP" -type f \( -name '*.pem' -o -name '*.crx' -o -name '*.legacy.*' \) | grep -q .; then
  echo "ERRO: arquivo proibido entrou no pacote."
  exit 1
fi

echo "Validando JavaScript..."
while IFS= read -r file; do
  node --check "$file" >/dev/null
done < <(find "$TMP/src" -type f -name '*.js' | sort)

if command -v zip >/dev/null 2>&1; then
  (
    cd "$TMP"
    zip -qr "$OUT" .
  )
elif command -v powershell.exe >/dev/null 2>&1; then
  WIN_TMP="$(cygpath -w "$TMP")"
  WIN_OUT="$(cygpath -w "$OUT")"

  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
    "Compress-Archive -Path '${WIN_TMP}\*' -DestinationPath '${WIN_OUT}' -Force"
elif command -v pwsh >/dev/null 2>&1; then
  pwsh -NoProfile -Command \
    "Compress-Archive -Path '$TMP/*' -DestinationPath '$OUT' -Force"
else
  echo "ERRO: nao encontrei zip, powershell.exe nem pwsh."
  exit 1
fi

rm -rf "$TMP"

[ -f "$OUT" ] || { echo "ERRO: ZIP nao foi criado."; exit 1; }

echo
echo "OK: ZIP criado com sucesso:"
echo "$OUT"
echo
echo "Conteudo esperado na raiz:"
echo "  manifest.json"
echo "  src/"
echo "  icons/"
