#!/bin/bash
# ============================================================
# Restore-Skript für Online Quiz Plattform
# ============================================================

set -e

# Konfiguration
BACKUP_DIR="${BACKUP_DIR:-./storage/backups}"
DATABASE_PATH="${DATABASE_PATH:-./storage/database/quiz.db}"
UPLOADS_DIR="${UPLOADS_DIR:-./storage/uploads}"

echo "=== Quiz Plattform Restore ==="
echo ""

# Verfügbare Backups anzeigen
echo "Verfügbare Backups:"
BACKUPS=($(ls -1td ${BACKUP_DIR}/quiz_backup_* 2>/dev/null))
if [ ${#BACKUPS[@]} -eq 0 ]; then
    echo "Keine Backups gefunden!"
    exit 1
fi

for i in "${!BACKUPS[@]}"; do
    NAME=$(basename "${BACKUPS[$i]}")
    DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "${BACKUPS[$i]}" 2>/dev/null || stat -c "%y" "${BACKUPS[$i]}" 2>/dev/null | cut -d' ' -f1)
    echo "  [$i] ${NAME} (${DATE})"
done

echo ""
read -p "Nummer des Backups zum Wiederherstellen [0]: " SELECTION
SELECTION=${SELECTION:-0}

if [ -z "${BACKUPS[$SELECTION]}" ]; then
    echo "Ungültige Auswahl!"
    exit 1
fi

BACKUP_PATH="${BACKUPS[$SELECTION]}"
BACKUP_NAME=$(basename "${BACKUP_PATH}")

echo ""
echo "Ausgewähltes Backup: ${BACKUP_NAME}"
echo ""

# Warnung
echo "WARNUNG: Dies überschreibt aktuelle Daten!"
read -p "Fortfahren? (j/N): " CONFIRM
if [ "$CONFIRM" != "j" ] && [ "$CONFIRM" != "J" ]; then
    echo "Abgebrochen."
    exit 0
fi

# Datenbank wiederherstellen
if [ -f "${BACKUP_PATH}/quiz.db" ]; then
    echo ""
    echo "Prüfe Datenbank-Integrität..."
    if sha256sum -c "${BACKUP_PATH}/quiz.db.sha256" 2>/dev/null; then
        echo "  -> Prüfsumme OK"
        echo "Stelle Datenbank wieder her..."
        
        # Backup der aktuellen DB erstellen
        if [ -f "${DATABASE_PATH}" ]; then
            mv "${DATABASE_PATH}" "${DATABASE_PATH}.old.$(date +%s)"
        fi
        
        cp "${BACKUP_PATH}/quiz.db" "${DATABASE_PATH}"
        chmod 644 "${DATABASE_PATH}"
        echo "  -> ${DATABASE_PATH}"
    else
        echo "  -> FEHLER: Prüfsumme stimmt nicht überein!"
        exit 1
    fi
else
    echo "Keine Datenbank in diesem Backup."
fi

# Uploads wiederherstellen
if [ -d "${BACKUP_PATH}/uploads" ]; then
    echo ""
    echo "Stelle Uploads wieder her..."
    rm -rf "${UPLOADS_DIR}" 2>/dev/null || true
    cp -r "${BACKUP_PATH}/uploads" "${UPLOADS_DIR}"
    echo "  -> ${UPLOADS_DIR}/"
fi

echo ""
echo "=== Restore abgeschlossen ==="
echo "Bitte starte den Server neu."
