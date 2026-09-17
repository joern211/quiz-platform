#!/bin/bash
# ============================================================
# Backup-Skript für Online Quiz Plattform
# ============================================================

set -e

# Konfiguration
BACKUP_DIR="${BACKUP_DIR:-./storage/backups}"
DATABASE_PATH="${DATABASE_PATH:-./storage/database/quiz.db}"
UPLOADS_DIR="${UPLOADS_DIR:-./storage/uploads}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

# Zeitstempel
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="quiz_backup_${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

echo "=== Quiz Plattform Backup ==="
echo "Zeit: $(date)"
echo ""

# Verzeichnis erstellen
mkdir -p "${BACKUP_PATH}"

# Datenbank sichern
if [ -f "${DATABASE_PATH}" ]; then
    echo "Sichere Datenbank..."
    cp "${DATABASE_PATH}" "${BACKUP_PATH}/quiz.db"
    echo "  -> ${BACKUP_PATH}/quiz.db"
else
    echo "Warnung: Datenbank nicht gefunden: ${DATABASE_PATH}"
fi

# Uploads sichern
if [ -d "${UPLOADS_DIR}" ] && [ "$(ls -A ${UPLOADS_DIR} 2>/dev/null)" ]; then
    echo "Sichere Uploads..."
    cp -r "${UPLOADS_DIR}" "${BACKUP_PATH}/uploads"
    echo "  -> ${BACKUP_PATH}/uploads/"
else
    echo "Keine Uploads zum Sichern."
fi

# Manifest erstellen
cat > "${BACKUP_PATH}/manifest.json" << EOF
{
  "timestamp": "${TIMESTAMP}",
  "createdAt": "$(date -Iseconds)",
  "version": "1.0.0",
  "components": {
    "database": $([ -f "${BACKUP_PATH}/quiz.db" ] && echo "true" || echo "false"),
    "uploads": $([ -d "${BACKUP_PATH}/uploads" ] && echo "true" || echo "false")
  }
}
EOF

# Prüfsummen erstellen
echo "Erstelle Prüfsummen..."
cd "${BACKUP_PATH}"
sha256sum quiz.db > quiz.db.sha256 2>/dev/null || true
find . -type f -exec sha256sum {} \; > checksums.sha256

echo ""
echo "Backup erstellt: ${BACKUP_PATH}"

# Alte Backups löschen
echo ""
echo "Prüfe alte Backups (Aufbewahrung: ${RETENTION_DAYS} Tage)..."
find "${BACKUP_DIR}" -maxdepth 1 -type d -name "quiz_backup_*" -mtime +${RETENTION_DAYS} -exec rm -rf {} \; 2>/dev/null || true

# Zusammenfassung
echo ""
echo "=== Aktuelle Backups ==="
ls -la "${BACKUP_DIR}"/quiz_backup_* 2>/dev/null | tail -5 || echo "Keine Backups gefunden."

echo ""
echo "Backup abgeschlossen!"
