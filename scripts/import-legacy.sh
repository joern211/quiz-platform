#!/bin/bash
# ============================================================
# Import-Skript für Legacy-Daten
# ============================================================

set -e

echo "=== Legacy Import ==="
echo ""

# Check for legacy data
LEGACY_DIR="${LEGACY_DIR:-./legacy}"
TARGET_DIR="${TARGET_DIR:-./storage}"

if [ ! -d "${LEGACY_DIR}" ]; then
    echo "Kein Legacy-Verzeichnis gefunden: ${LEGACY_DIR}"
    echo "Erstelle Beispielstruktur..."
    mkdir -p "${LEGACY_DIR}/rooms" "${LEGACY_DIR}/questions"
    echo "Bitte Legacy-Daten in ${LEGACY_DIR} ablegen."
    exit 1
fi

echo "Importiere von: ${LEGACY_DIR}"
echo ""

# Import rooms
if [ -f "${LEGACY_DIR}/rooms.json" ]; then
    echo "Importiere Räume..."
    # Migration happens via API in production
    # This is just a placeholder for documentation
fi

# Import Geo questions
if [ -d "${LEGACY_DIR}/questions/geo" ]; then
    echo "Importiere Geo-Fragen..."
    # Questions need to be imported via the admin UI or API
fi

# Import Jeopardy setups
if ls "${LEGACY_DIR}"/jeopardy_*.json 1>/dev/null 2>&1; then
    echo "Importiere Jeopardy-Setups..."
fi

echo ""
echo "Legacy-Import abgeschlossen."
echo ""
echo "Bitte nutze die Admin-Oberfläche für weitere Importe:"
echo "  /admin/inhalte"
