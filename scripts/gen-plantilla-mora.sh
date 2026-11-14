#!/usr/bin/env bash
# Genera la plantilla de liquidación y la recalcula con LibreOffice para que el archivo traiga los valores calculados.
set -euo pipefail
cd "$(dirname "$0")/.."
python3.13 scripts/gen-plantilla-mora.py
T="$(mktemp -d)"; cp public/mora/Plantilla_liquidacion_impuestos.xlsx "$T/in.xlsx"
libreoffice --headless --convert-to xlsx:"Calc MS Excel 2007 XML" --outdir "$T/out" "$T/in.xlsx" >/dev/null 2>&1
cp "$T/out/in.xlsx" public/mora/Plantilla_liquidacion_impuestos.xlsx
echo "Plantilla lista: public/mora/Plantilla_liquidacion_impuestos.xlsx"
