// ============================================================
// Geo Setup Page (Question Selection & Configuration)
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Card, Button, Input, Badge } from '@quiz/ui';
import styles from './GeoSetupPage.module.css';

interface GeoQuestion {
  id: string;
  category: string;
  prompt: string;
  options: { id: string; text: string }[];
}

export function GeoSetupPage() {
  const { gameSlug } = useParams<{ gameSlug: string }>();
  const navigate = useNavigate();
  
  const [questions, setQuestions] = useState<GeoQuestion[]>([]);
  const [selectedQuestions, setSelectedQuestions] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [categories, setCategories] = useState<string[]>([]);
  const [roomName, setRoomName] = useState('');
  const [pin, setPin] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(10);
  const [allowViewers, setAllowViewers] = useState(true);
  const [joker5050, setJoker5050] = useState(1);
  const [jokerSpy, setJokerSpy] = useState(1);
  const [jokerRisk, setJokerRisk] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadQuestions();
  }, [gameSlug]);

  const loadQuestions = async () => {
    try {
      // Load demo questions for now
      const demoQuestions: GeoQuestion[] = [
        {
          id: '1',
          category: 'Hauptstädte',
          prompt: 'Was ist die Hauptstadt von Frankreich?',
          options: [
            { id: 'a', text: 'London' },
            { id: 'b', text: 'Paris' },
            { id: 'c', text: 'Berlin' },
            { id: 'd', text: 'Madrid' },
          ],
        },
        {
          id: '2',
          category: 'Flaggen',
          prompt: 'Welches Land hat diese Flagge? 🏴🇩🇪',
          options: [
            { id: 'a', text: 'Deutschland' },
            { id: 'b', text: 'Belgien' },
            { id: 'c', text: 'Österreich' },
            { id: 'd', text: 'Schweiz' },
          ],
        },
        {
          id: '3',
          category: 'Flüsse und Berge',
          prompt: 'Welcher Fluss ist der längste der Welt?',
          options: [
            { id: 'a', text: 'Amazonas' },
            { id: 'b', text: 'Nil' },
            { id: 'c', text: 'Jangtsekiang' },
            { id: 'd', text: 'Mississippi' },
          ],
        },
        {
          id: '4',
          category: 'Sprachen',
          prompt: 'In welcher Sprache spricht man "Olá"?',
          options: [
            { id: 'a', text: 'Spanisch' },
            { id: 'b', text: 'Portugiesisch' },
            { id: 'c', text: 'Italienisch' },
            { id: 'd', text: 'Französisch' },
          ],
        },
        {
          id: '5',
          category: 'Allgemein',
          prompt: 'Wie viele Kontinente gibt es?',
          options: [
            { id: 'a', text: '5' },
            { id: 'b', text: '6' },
            { id: 'c', text: '7' },
            { id: 'd', text: '8' },
          ],
        },
        {
          id: '6',
          category: 'Hauptstädte',
          prompt: 'Was ist die Hauptstadt von Japan?',
          options: [
            { id: 'a', text: 'Seoul' },
            { id: 'b', text: 'Peking' },
            { id: 'c', text: 'Tokio' },
            { id: 'd', text: 'Bangkok' },
          ],
        },
      ];
      
      setQuestions(demoQuestions);
      const cats = [...new Set(demoQuestions.map(q => q.category))];
      setCategories(cats);
    } catch {
      console.error('Failed to load questions');
    } finally {
      setLoading(false);
    }
  };

  const filteredQuestions = categoryFilter === 'all' 
    ? questions 
    : questions.filter(q => q.category === categoryFilter);

  const toggleQuestion = (id: string) => {
    setSelectedQuestions(prev =>
      prev.includes(id)
        ? prev.filter(q => q !== id)
        : [...prev, id]
    );
  };

  const handleCreateRoom = async () => {
    if (selectedQuestions.length === 0) {
      alert('Bitte wähle mindestens eine Frage aus');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/v1/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          gameSlug: 'geo',
          roomName: roomName || 'Geo-Quiz',
          pin: pin || undefined,
          maxPlayers,
          allowViewers,
          setup: {
            questions: selectedQuestions.map(id => 
              questions.find(q => q.id === id)
            ),
            jokers: {
             5050: joker5050,
              spy: jokerSpy,
              risk: jokerRisk,
            },
          },
        }),
      });

      const data = await res.json();
      if (res.ok) {
        navigate(`/moderator/raum/${data.code}/lobby`);
      } else {
        alert(data.error || 'Fehler beim Erstellen');
      }
    } catch {
      alert('Verbindungsfehler');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className={styles.page}>Laden...</div>;
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Geografie-Quiz einrichten</h1>

      <div className={styles.grid}>
        <Card padding="lg" className={styles.questionSection}>
          <div className={styles.sectionHeader}>
            <h2>Fragen auswählen</h2>
            <Badge>{selectedQuestions.length} ausgewählt</Badge>
          </div>

          <div className={styles.filters}>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className={styles.filterSelect}
            >
              <option value="all">Alle Kategorien</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          <div className={styles.questionList}>
            {filteredQuestions.map((q, i) => (
              <div
                key={q.id}
                className={`${styles.questionItem} ${selectedQuestions.includes(q.id) ? styles.selected : ''}`}
                onClick={() => toggleQuestion(q.id)}
              >
                <div className={styles.questionHeader}>
                  <span className={styles.questionIndex}>{i + 1}</span>
                  <Badge size="sm" variant="muted">{q.category}</Badge>
                </div>
                <p className={styles.questionPrompt}>{q.prompt}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card padding="lg" className={styles.configSection}>
          <h2>Raum-Einstellungen</h2>
          
          <div className={styles.configForm}>
            <Input
              label="Raumname"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Mein Geo-Quiz"
            />

            <Input
              label="PIN (optional)"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••"
              maxLength={4}
            />

            <div className={styles.configRow}>
              <label>Max. Spieler</label>
              <select
                value={maxPlayers}
                onChange={(e) => setMaxPlayers(Number(e.target.value))}
                className={styles.filterSelect}
              >
                {[2, 4, 6, 8, 10].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>

            <div className={styles.configRow}>
              <label>Zuschauer erlaubt</label>
              <input
                type="checkbox"
                checked={allowViewers}
                onChange={(e) => setAllowViewers(e.target.checked)}
              />
            </div>
          </div>

          <h3 className={styles.jokerTitle}>Joker</h3>
          
          <div className={styles.jokerConfig}>
            <div className={styles.jokerRow}>
              <span>50:50</span>
              <select
                value={joker5050}
                onChange={(e) => setJoker5050(Number(e.target.value))}
                className={styles.filterSelect}
              >
                {[0, 1, 2, 3].map(n => (
                  <option key={n} value={n}>{n}x</option>
                ))}
              </select>
            </div>

            <div className={styles.jokerRow}>
              <span>Spy</span>
              <select
                value={jokerSpy}
                onChange={(e) => setJokerSpy(Number(e.target.value))}
                className={styles.filterSelect}
              >
                {[0, 1, 2, 3].map(n => (
                  <option key={n} value={n}>{n}x</option>
                ))}
              </select>
            </div>

            <div className={styles.jokerRow}>
              <span>Risk ×2</span>
              <select
                value={jokerRisk}
                onChange={(e) => setJokerRisk(Number(e.target.value))}
                className={styles.filterSelect}
              >
                {[0, 1, 2, 3].map(n => (
                  <option key={n} value={n}>{n}x</option>
                ))}
              </select>
            </div>
          </div>

          <Button 
            onClick={handleCreateRoom} 
            fullWidth 
            loading={saving}
            disabled={selectedQuestions.length === 0}
          >
            Raum erstellen
          </Button>
        </Card>
      </div>
    </div>
  );
}
