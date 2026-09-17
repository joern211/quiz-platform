#!/bin/bash
# ============================================================
# Restore-Skript für Online Quiz Plattform
# ============================================================
#
# Verwendung:
#   pnpm restore                    # Interaktiver Restore
#   SELECTION=0 pnpm restore        # Automatisch Backup 0 wiederherstellen
#   BACKUP_DIR=/path/to/backups pnpm restore
#
# Umgebungsvariablen:
#   BACKUP_DIR    - Backup-Verzeichnis (Standard: ./storage/backups)
#   DATABASE_URL  - Datenbank-URL (Standard: file:./storage/database/quiz.db)
#   UPLOADS_DIR   - Uploads-Verzeichnis (Standard: ./storage/uploads)
#   SELECTION     - Backup-Index für automatisches Restore (ohne Nachfrage)
#

set -e

# Konfiguration aus Umgebung oder Standard
BACKUP_DIR="${BACKUP_DIR:-./storage/backups}"

# Datenbank-Pfad aus DATABASE_URL extrahieren oder Standard verwenden
DATABASE_URL="${DATABASE_URL:-file:./storage/database/quiz.db}"
if [[ "$DATABASE_URL" == file:* ]]; then
    DB_PATH="${DATABASE_URL#file:}"
    if [[ "$DB_PATH" != /* ]]; then
        DATABASE_PATH="$(cd "$(dirname "$DB_PATH")" 2>/dev/null && pwd)/$(basename "$DB_PATH")"
    else
        DATABASE_PATH="$DB_PATH"
    fi
else
    DATABASE_PATH=""
fi

UPLOADS_DIR="${UPLOADS_DIR:-./storage/uploads}"

echo "=== Quiz Plattform Restore ==="
echo ""

# Verfügbare Backups anzeigen
echo "Verfügbare Backups in: ${BACKUP_DIR}"
BACKUPS=($(ls -1td "${BACKUP_DIR}"/quiz_backup_* 2>/dev/null))

if [ ${#BACKUPS[@]} -eq 0 ]; then
    echo "Keine Backups gefunden!"
    echo ""
    echo "Tipp: Backups werden mit 'pnpm backup' erstellt."
    exit 1
fi

for i in "${!BACKUPS[@]}"; do
    NAME=$(basename "${BACKUPS[$i]}")
    # Cross-platform date extraction
    if [[ "$(uname)" == "Darwin" ]]; then
        DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "${BACKUPS[$i]}" 2>/dev/null || echo "unbekannt")
    else
        DATE=$(stat -c "%y" "${BACKUPS[$i]}" 2>/dev/null | cut -d' ' -f1)
    fi
    SIZE=$(du -sh "${BACKUPS[$i]}" 2>/dev/null | cut -f1 || echo "?")
    echo "  [$i] ${NAME} (${DATE}, ${SIZE})"
done

echo ""

# Interaktiv oder automatisch?
if [ -n "${SELECTION}" ]; then
    echo "Automatische Auswahl: Index ${SELECTION}"
    CONFIRM="j"
else
    read -p "Nummer des Backups zum Wiederherstellen [0]: " SELECTION
    SELECTION=${SELECTION:-0}
    
    echo ""
    echo "Ausgewähltes Backup: $(basename "${BACKUPS[$SELECTION]}")"
    echo ""
    echo "WARNUNG: Dies überschreibt aktuelle Daten!"
    read -p "Fortfahren? (j/N): " CONFIRM
fi

if [ "$CONFIRM" != "j" ] && [ "$CONFIRM" != "J" ]; then
    echo "Abgebrochen."
    exit 0
fi

# Validierung
if [ -z "${BACKUPS[$SELECTION]}" ]; then
    echo "Ungültige Auswahl: ${SELECTION}"
    exit 1
fi

BACKUP_PATH="${BACKUPS[$SELECTION]}"
BACKUP_NAME=$(basename "${BACKUP_PATH}")

echo ""
echo "Stelle Backup '${BACKUP_NAME}' wieder her..."

# ============================================================
# Datenbank wiederherstellen
# ============================================================
if [ -f "${BACKUP_PATH}/quiz.db" ]; then
    echo ""
    echo "Prüfe Datenbank-Integrität..."
    
    if [ -f "${BACKUP_PATH}/quiz.db.sha256" ]; then
        if sha256sum -c "${BACKUP_PATH}/quiz.db.sha256" 2>/dev/null; then
            echo "  -> Prüfsumme OK"
        else
            echo "  -> FEHLER: Prüfsumme stimmt nicht überein!"
            echo "  -> Backup möglicherweise beschädigt oder manipuliert."
            exit 1
        fi
    else
        echo "  -> Warnung: Keine Prüfsumme vorhanden, überspringe Prüfung"
    fi
    
    echo "Stelle Datenbank wieder her..."
    
    # Backup der aktuellen DB erstellen
    if [ -n "$DATABASE_PATH" ] && [ -f "$DATABASE_PATH" ]; then
        TIMESTAMP=$(date +%s)
        mv "$DATABASE_PATH" "${DATABASE_PATH}.old.${TIMESTAMP}"
        echo "  -> Alte Datenbank gesichert als: ${DATABASE_PATH}.old.${TIMESTAMP}"
    fi
    
    cp "${BACKUP_PATH}/quiz.db" "$DATABASE_PATH"
    chmod 644 "$DATABASE_PATH"
    echo "  -> Wiederhergestellt: $DATABASE_PATH"
else
    echo "Keine Datenbank in diesem Backup."
fi

# ============================================================
# Uploads wiederherstellen
# ============================================================
if [ -d "${BACKUP_PATH}/uploads" ]; then
    echo ""
    echo "Stelle Uploads wieder her..."
    
    # Alte Uploads sichern
    if [ -d "$UPLOADS_DIR" ]; then
        TIMESTAMP=$(date +%s)
        mv "$UPLOADS_DIR" "${UPLOADS_DIR}.old.${TIMESTAMP}"
        echo "  -> Alte Uploads gesichert als: ${UPLOADS_DIR}.old.${TIMESTAMP}"
    fi
    
    cp -r "${BACKUP_PATH}/uploads" "$UPLOADS_DIR"
    echo "  -> Wiederhergestellt: $UPLOADS_DIR/"
fi

echo ""
echo "=== Restore abgeschlossen ==="
echo ""
echo "Bitte starte den Server neu."
echo ""
echo "Tipp: Alte Daten (falls vorhanden) wurden mit '.old.*' gesichert."
