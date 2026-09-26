// ============================================================
// Jeopardy Setup Page
// ============================================================

import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Card, Button, Input } from '@quiz/ui';
import styles from './JeopardySetupPage.module.css';

interface Category {
  id: string;
  title: string;
  clues: { id: string; value: number; question: string; answer: string; type: 'text' | 'image' | 'audio' }[];
}

interface Board {
  categories: Category[];
}

// ── Zod Validation Schema ─────────────────────────────────────

const clueSchema = z.object({
  value: z.number().positive('Punktwert muss positiv sein.'),
  question: z.string().min(1, 'Frage darf nicht leer sein.'),
  answer: z.string().min(1, 'Antwort darf nicht leer sein.'),
});

const categorySchema = z.object({
  name: z.string().min(1, 'Kategoriename darf nicht leer sein.'),
  clues: z.array(clueSchema).min(5).max(5),
});

const boardSchema = z.object({
  categories: z.array(categorySchema).min(6).max(6),
});

export const JeopardyBoardSchema = z.object({
  board1: boardSchema,
  board2: boardSchema,
});

// Re-export Board type from JeopardySetupPage
export type { Board as JeopardyBoard };

export type JeopardyValidationError = {
  board1?: { categories?: Array<{ name?: string[]; clues?: Array<{ question?: string[]; answer?: string[] }> }> };
  board2?: { categories?: Array<{ name?: string[]; clues?: Array<{ question?: string[]; answer?: string[] }> }> };
};

export function JeopardySetupPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [board1, setBoard1] = useState<Board>({ categories: Array(6).fill(null).map((_, i) => ({
    id: `cat1-${i}`,
    title: '',
    clues: [100, 200, 300, 400, 500].map((v) => ({
      id: `cat1-${i}-${v}`,
      value: v,
      question: '',
      answer: '',
      type: 'text' as const,
    })),
  }))});
  
  const [board2, setBoard2] = useState<Board>({ categories: Array(6).fill(null).map((_, i) => ({
    id: `cat2-${i}`,
    title: '',
    clues: [200, 400, 600, 800, 1000].map((v) => ({
      id: `cat2-${i}-${v}`,
      value: v,
      question: '',
      answer: '',
      type: 'text' as const,
    })),
  }))});
  
  const [currentBoard, setCurrentBoard] = useState<1 | 2>(1);
  const [currentCat, setCurrentCat] = useState(0);
  const [currentClue, setCurrentClue] = useState(0);
  const [editingField, setEditingField] = useState<'question' | 'answer' | 'title'>('question');
  const [roomName, setRoomName] = useState('');
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);

  const currentBoardData = currentBoard === 1 ? board1 : board2;
  const setCurrentBoardData = currentBoard === 1 ? setBoard1 : setBoard2;
  const currentCategory = currentBoardData.categories[currentCat];
  const currentClueData = currentCategory?.clues[currentClue];

  const handleFieldChange = (value: string) => {
    const newBoard = { ...currentBoardData };
    if (editingField === 'title') {
      newBoard.categories[currentCat].title = value;
    } else {
      newBoard.categories[currentCat].clues[currentClue][editingField] = value;
    }
    setCurrentBoardData(newBoard);
  };

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        // Import board JSON — accept both `title` (legacy) and `name` (engine) as category key
        const importedBoard = (source: Board | undefined, current: Board): Board | null => {
          if (!source?.categories) return null;
          return { categories: current.categories.map((category, i) => {
            const imported = source.categories[i];
            return imported ? {
              ...category,
              title: imported.title || (imported as Category & { name?: string }).name || '',
              clues: category.clues.map((clue, j) => ({
                ...clue,
                question: imported.clues?.[j]?.question || '',
                answer: imported.clues?.[j]?.answer || '',
                type: imported.clues?.[j]?.type || 'text',
              })),
            } : category;
          }) };
        };
        const nextBoard1 = importedBoard(data.board1, board1);
        const nextBoard2 = importedBoard(data.board2, board2);
        if (nextBoard1) setBoard1(nextBoard1);
        if (nextBoard2) setBoard2(nextBoard2);
      } catch {
        alert('Ungültiges Dateiformat');
      }
    };
    reader.readAsText(file);
  };

  const handleExport = () => {
    const data = {
      meta: { version: 1, exportedAt: new Date().toISOString() },
      board1: { categories: board1.categories.map(c => ({ title: c.title, clues: c.clues })) },
      board2: { categories: board2.categories.map(c => ({ title: c.title, clues: c.clues })) },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jeopardy-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

// Helper: transform board with `title` → `name` for engine compatibility
  const toEngineBoard = (board: Board) => ({
    categories: board.categories.map(c => ({
      name: c.title,
      clues: c.clues.map(({ value, question, answer, type }) => ({ value, question, answer, type })),
    })),
  });

  const handleCreateRoom = async () => {
    setApiError(null);
    setValidationErrors([]);

    // Phase 2: Zod validation before room creation
    const engineBoard1 = toEngineBoard(board1);
    const engineBoard2 = toEngineBoard(board2);
    const validation = JeopardyBoardSchema.safeParse({ board1: engineBoard1, board2: engineBoard2 });
    if (!validation.success) {
      const errors = validation.error.errors.map(e => {
        const path0 = String(e.path[0] ?? '');
        // Category index is e.path[1] — could be 0 (valid) or undefined (root error)
        const catIdx = e.path.length > 1 && e.path[1] !== undefined
          ? Number(e.path[1])
          : null;
        const field = e.path.length > 2 ? String(e.path[2]) : '';
        const boardLabel = path0 === 'board1' ? 'Board 1' : path0 === 'board2' ? 'Board 2' : path0;
        const catLabel = catIdx !== null ? `Kategorie ${catIdx + 1}` : '';
        return `${boardLabel} ${catLabel} ${field}: ${e.message}`.trim();
      });
      setValidationErrors(errors);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/v1/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          gameSlug: 'jeopardy',
          roomName: roomName || 'Jeopardy',
          pin: pin || undefined,
          maxPlayers: 10,
          allowViewers: true,
          isPublic: true,
          setupSnapshotJson: { board1: engineBoard1, board2: engineBoard2 },
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setApiError(json.error?.message ?? `Fehler ${res.status}: Raum konnte nicht erstellt werden.`);
        return;
      }
      if (json.success && json.data?.code) {
        navigate(`/moderator/raum/${json.data.code}/lobby`);
      } else {
        setApiError(json.error?.message ?? 'Fehler beim Erstellen');
      }
    } catch {
      setApiError('Netzwerkfehler: Server nicht erreichbar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Jeopardy einrichten</h1>

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <div className={styles.errorBanner} role="alert">
          <strong>Bitte fülle alle Pflichtfelder aus:</strong>
          <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>
            {validationErrors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* API error */}
      {apiError && (
        <div className={styles.errorBanner} role="alert">
          {apiError}
        </div>
      )}

      <div className={styles.boardTabs}>
        <button 
          className={`${styles.tab} ${currentBoard === 1 ? styles.active : ''}`}
          onClick={() => setCurrentBoard(1)}
        >
          Board 1 (100-500)
        </button>
        <button 
          className={`${styles.tab} ${currentBoard === 2 ? styles.active : ''}`}
          onClick={() => setCurrentBoard(2)}
        >
          Board 2 (200-1000)
        </button>
      </div>

      <div className={styles.grid}>
        <Card padding="lg" className={styles.editor}>
          <h2>Fragen-Editor</h2>

          <div className={styles.categorySelect}>
            {currentBoardData.categories.map((cat, i) => (
              <button
                key={cat.id}
                className={`${styles.catBtn} ${i === currentCat ? styles.active : ''}`}
                onClick={() => setCurrentCat(i)}
              >
                {cat.title || `Kategorie ${i + 1}`}
              </button>
            ))}
          </div>

          <div className={styles.clueSelect}>
            {currentCategory?.clues.map((clue, i) => (
              <button
                key={clue.id}
                className={`${styles.clueBtn} ${i === currentClue ? styles.active : ''}`}
                onClick={() => setCurrentClue(i)}
              >
                {clue.value}
              </button>
            ))}
          </div>

          <div className={styles.fieldTabs}>
            <button 
              className={`${styles.fieldTab} ${editingField === 'title' ? styles.active : ''}`}
              onClick={() => setEditingField('title')}
            >
              Titel
            </button>
            <button 
              className={`${styles.fieldTab} ${editingField === 'question' ? styles.active : ''}`}
              onClick={() => setEditingField('question')}
            >
              Frage
            </button>
            <button 
              className={`${styles.fieldTab} ${editingField === 'answer' ? styles.active : ''}`}
              onClick={() => setEditingField('answer')}
            >
              Antwort
            </button>
          </div>

          <textarea
            className={styles.textarea}
            value={
              editingField === 'title' 
                ? currentCategory?.title || ''
                : currentClueData?.[editingField] || ''
            }
            onChange={(e) => handleFieldChange(e.target.value)}
            placeholder={
              editingField === 'title' 
                ? 'Kategorietitel eingeben...'
                : editingField === 'question'
                ? 'Frage eingeben...'
                : 'Antwort eingeben...'
            }
            rows={4}
          />

          <div className={styles.importExport}>
            <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
              Importieren
            </Button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImport}
              accept=".json"
              style={{ display: 'none' }}
            />
            <Button variant="secondary" onClick={handleExport}>
              Exportieren
            </Button>
          </div>
        </Card>

        <Card padding="lg" className={styles.preview}>
          <h2>Vorschau</h2>
          <div className={styles.boardPreview}>
            {currentBoardData.categories.map((cat, catIdx) => (
              <div key={cat.id} className={styles.previewColumn}>
                <div className={styles.previewHeader}>{cat.title || `Kat. ${catIdx + 1}`}</div>
                {cat.clues.map((clue) => (
                  <div key={clue.id} className={styles.previewCell}>
                    {clue.value}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Card>

        <Card padding="lg" className={styles.settings}>
          <h2>Raum-Einstellungen</h2>
          
          <Input
            label="Raumname"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder="Mein Jeopardy"
          />

          <Input
            label="PIN (optional)"
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
          />

          <Button onClick={handleCreateRoom} fullWidth loading={saving}>
            Raum erstellen
          </Button>
        </Card>
      </div>
    </div>
  );
}
