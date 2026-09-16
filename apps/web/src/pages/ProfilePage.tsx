// ============================================================
// Player Profile Page
// ============================================================

import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Card, Button, Input } from '@quiz/ui';
import styles from './ProfilePage.module.css';

export function ProfilePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState<'name' | 'avatar'>('name');
  const [displayName, setDisplayName] = useState('');
  const [avatarMode, setAvatarMode] = useState<'none' | 'avatar' | 'camera'>('none');
  const [avatarColor, setAvatarColor] = useState('#1dd4d4');
  const [avatarIcon, setAvatarIcon] = useState('😊');
  const [previewInitials, setPreviewInitials] = useState('');

  const colors = ['#1dd4d4', '#00d2ff', '#1dd1a1', '#feca57', '#ff5d73', '#a78bfa', '#f97316', '#ec4899'];
  const icons = ['😊', '😎', '🤓', '😺', '🦊', '🐱', '🦁', '🐶', '🦄', '🌟', '⚡', '🔥'];

  const handleNameNext = () => {
    if (displayName.trim().length >= 2) {
      setPreviewInitials(displayName.trim().slice(0, 2).toUpperCase());
      setStep('avatar');
    }
  };

  const handleFinish = () => {
    const profile = {
      displayName: displayName.trim(),
      avatarMode,
      avatarColor: avatarMode !== 'none' ? avatarColor : undefined,
      avatarIcon: avatarMode === 'avatar' ? avatarIcon : undefined,
    };
    localStorage.setItem('playerProfile', JSON.stringify(profile));
    
    // Navigate back or to room selection
    const state = location.state as { redirectTo?: string; code?: string };
    if (state?.code) {
      navigate(`/raum/${state.code}/lobby`);
    } else {
      navigate('/');
    }
  };

  return (
    <div className={styles.page}>
      <Card padding="lg" className={styles.card}>
        <div className={styles.steps}>
          <div className={`${styles.step} ${step === 'name' ? styles.active : ''}`}>
            <span className={styles.stepNumber}>1</span>
            <span>Name</span>
          </div>
          <div className={styles.stepLine} />
          <div className={`${styles.step} ${step === 'avatar' ? styles.active : ''}`}>
            <span className={styles.stepNumber}>2</span>
            <span>Avatar</span>
          </div>
        </div>

        {step === 'name' ? (
          <div className={styles.stepContent}>
            <h1>Wie heißt du?</h1>
            <p className={styles.hint}>
              Dein Name wird anderen Spielern angezeigt
            </p>
            
            <Input
              label="Anzeigename"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Dein Name"
              maxLength={20}
              autoFocus
            />

            <Button onClick={handleNameNext} fullWidth disabled={displayName.trim().length < 2}>
              Weiter
            </Button>
          </div>
        ) : (
          <div className={styles.stepContent}>
            <h1>Wähle deinen Avatar</h1>
            <p className={styles.hint}>
              Optional - du kannst auch ohne Avatar spielen
            </p>

            <div className={styles.avatarModes}>
              <button
                className={`${styles.avatarMode} ${avatarMode === 'none' ? styles.selected : ''}`}
                onClick={() => setAvatarMode('none')}
              >
                <div className={styles.modeIcon}>🚫</div>
                <span>Kein Avatar</span>
              </button>
              <button
                className={`${styles.avatarMode} ${avatarMode === 'avatar' ? styles.selected : ''}`}
                onClick={() => setAvatarMode('avatar')}
              >
                <div className={styles.modeIcon}>😊</div>
                <span>Eigener Avatar</span>
              </button>
            </div>

            {avatarMode === 'avatar' && (
              <div className={styles.avatarCustom}>
                <div 
                  className={styles.avatarPreview}
                  style={{ backgroundColor: avatarColor }}
                >
                  {avatarIcon}
                </div>

                <div className={styles.colorPicker}>
                  <label>Farbe</label>
                  <div className={styles.colors}>
                    {colors.map(color => (
                      <button
                        key={color}
                        className={`${styles.colorBtn} ${avatarColor === color ? styles.selected : ''}`}
                        style={{ backgroundColor: color }}
                        onClick={() => setAvatarColor(color)}
                      />
                    ))}
                  </div>
                </div>

                <div className={styles.iconPicker}>
                  <label>Symbol</label>
                  <div className={styles.icons}>
                    {icons.map(icon => (
                      <button
                        key={icon}
                        className={`${styles.iconBtn} ${avatarIcon === icon ? styles.selected : ''}`}
                        onClick={() => setAvatarIcon(icon)}
                      >
                        {icon}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className={styles.actions}>
              <Button variant="secondary" onClick={() => setStep('name')}>
                Zurück
              </Button>
              <Button onClick={handleFinish}>
                Fertig
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
