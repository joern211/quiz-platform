// ============================================================
// Geo Jeopardy Setup Page
// ============================================================

import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Button, Input, Badge } from '@quiz/ui';
import styles from './JeopardySetupPage.module.css';

interface Category {
  id: string;
  title: string;
  clues: { id: string; value: number; question: string; answer: string; type: 'text' | 'image' | 'audio' }[];
}

interface Board {
  categories: Category[];
}

export function JeopardySetupPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [board1, setBoard1] = useState<Board>({ categories: Array(6).fill(null).map((_, i) => ({
    id: `cat1-${i}`,
    title: '',
    clues: [100, 200, 300, 400, 500].map((v, j) => ({
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
    clues: [200, 400, 600, 800, 1000].map((v, j) => ({
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
        // Simple import - just copy titles
        if (data.board1?.categories) {
          const newBoard1 = { ...board1 };
          data.board1.categories.slice(0, 6).forEach((cat: any, i: number) => {
            if (newBoard1.categories[i]) {
              newBoard1.categories[i].title = cat.title || '';
              cat.clues?.slice(0, 5).forEach((clue: any, j: number) => {
                if (newBoard1.categories[i].clues[j]) {
                  newBoard1.categories[i].clues[j].question = clue.question || '';
                  newBoard1.categories[i].clues[j].answer = clue.answer || '';
                }
              });
            }
          });
          setBoard1(newBoard1);
        }
      } catch (err) {
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

  const handleCreateRoom = async () => {
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
          setup: { board1, board2 },
        }),
      });

      const data = await res.json();
      if (res.ok) {
        navigate(`/moderator/raum/${data.code}/lobby`);
      }
    } catch (err) {
      alert('Fehler beim Erstellen');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Jeopardy einrichten</h1>

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
