// ============================================================
// Profile Page - AV Setup + Display Name
// ============================================================

import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Card, Button, Input } from '@quiz/ui';
import styles from './ProfilePage.module.css';

export function ProfilePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as { redirectTo?: string; code?: string } | null;
  const redirectTo = locationState?.redirectTo;
  const roomCode = locationState?.code;

  // Display name (load from sessionStorage if available)
  const [displayName, setDisplayName] = useState(() => {
    // First check sessionStorage (current session)
    const sessionProfile = sessionStorage.getItem('playerProfile');
    if (sessionProfile) {
      try {
        const profile = JSON.parse(sessionProfile);
        return profile.displayName || '';
      } catch { /* ignore */ }
    }
    // Fallback to localStorage (legacy)
    return localStorage.getItem('displayName') || '';
  });
  const [nameError, setNameError] = useState('');

  // AV devices
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>('');
  const [selectedMicrophone, setSelectedMicrophone] = useState<string>('');

  // Camera preview
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraLoading, setCameraLoading] = useState(true);

  // Enumerate devices and start preview
  useEffect(() => {
    async function initCamera() {
      try {
        // Request permission first
        await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(stream => {
          stream.getTracks().forEach(t => t.stop());
        });
      } catch {
        // Permission denied is ok – we'll show error only if user tries to use camera
      }
    }

    initCamera();

    return () => {
      stopStream();
    };
  }, []);

  // Load device list after permission
  useEffect(() => {
    async function loadDevices() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        const audioDevices = devices.filter(d => d.kind === 'audioinput');
        setCameras(videoDevices);
        setMicrophones(audioDevices);

        // Default to first camera/mic
        if (videoDevices.length > 0 && !selectedCamera) {
          setSelectedCamera(videoDevices[0].deviceId);
        }
        if (audioDevices.length > 0 && !selectedMicrophone) {
          setSelectedMicrophone(audioDevices[0].deviceId);
        }
      } catch (err) {
        console.error('Failed to enumerate devices', err);
      }
    }

    loadDevices();

    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
  }, [selectedCamera]);

  // Start camera preview when camera device changes
  useEffect(() => {
    if (!selectedCamera) return;
    startPreview();
  }, [selectedCamera]);

  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }

  async function startPreview() {
    setCameraLoading(true);
    setCameraError(null);
    stopStream();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: selectedCamera ? { exact: selectedCamera } : undefined },
        audio: selectedMicrophone ? { deviceId: { exact: selectedMicrophone } } : false,
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
      setCameraLoading(false);
    } catch {
      setCameraError('Kamera konnte nicht gestartet werden');
      setCameraLoading(false);
    }
  }

  function handlePreviewCamera() {
    startPreview();
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDisplayName(e.target.value);
    setNameError('');
  }

  function handleSubmit() {
    if (displayName.trim().length < 2) {
      setNameError('Name muss mindestens 2 Zeichen haben');
      return;
    }

    // Save profile to sessionStorage (P1-1: persisted in session not localStorage)
    const profile = {
      displayName: displayName.trim(),
      cameraDeviceId: selectedCamera || undefined,
      microphoneDeviceId: selectedMicrophone || undefined,
    };
    sessionStorage.setItem('playerProfile', JSON.stringify(profile));
    sessionStorage.setItem('displayName', displayName.trim());

    // P1-1/FLOW-004: Navigate to PlayerLobbyPage after AV setup
    if (roomCode) {
      navigate(`/raum/${roomCode}/lobby`);
    } else if (redirectTo === 'join') {
      navigate('/beitreten');
    } else {
      navigate('/kategorien');
    }
  }

  return (
    <div className={styles.page}>
      <Card padding="lg" className={styles.card}>
        <h1 className={styles.title}>Dein Profil</h1>
        <p className={styles.subtitle}>Wähle deinen Anzeigenamen und richte Kamera/Mikrofon ein</p>

        <div className={styles.form}>
          {/* Display Name */}
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Anzeigename</h2>
            <Input
              label="Anzeigename"
              value={displayName}
              onChange={handleNameChange}
              placeholder="Dein Name"
              maxLength={20}
              autoFocus
              error={nameError}
            />
            {displayName.trim().length >= 2 && (
              <p className={styles.preview}>
                Vorschau: <strong>{displayName.trim()}</strong> wird anderen Spielern angezeigt
              </p>
            )}
          </div>

          {/* Camera Preview */}
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Kamera</h2>

            <div className={styles.previewWrapper}>
              {cameraLoading && !cameraError && (
                <div className={styles.previewOverlay}>
                  <span>Kamera wird geladen...</span>
                </div>
              )}
              {cameraError ? (
                <div className={styles.previewError}>
                  <span>{cameraError}</span>
                  <Button size="sm" variant="secondary" onClick={handlePreviewCamera}>
                    Erneut versuchen
                  </Button>
                </div>
              ) : (
                <video
                  ref={videoRef}
                  className={styles.videoPreview}
                  autoPlay
                  muted
                  playsInline
                />
              )}
            </div>

            <div className={styles.deviceSelects}>
              <div className={styles.deviceGroup}>
                <label className={styles.deviceLabel}>Kamera</label>
                <select
                  className={styles.deviceSelect}
                  value={selectedCamera}
                  onChange={e => setSelectedCamera(e.target.value)}
                >
                  <option value="">Keine Kamera</option>
                  {cameras.map(cam => (
                    <option key={cam.deviceId} value={cam.deviceId}>
                      {cam.label || `Kamera ${cameras.indexOf(cam) + 1}`}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.deviceGroup}>
                <label className={styles.deviceLabel}>Mikrofon</label>
                <select
                  className={styles.deviceSelect}
                  value={selectedMicrophone}
                  onChange={e => setSelectedMicrophone(e.target.value)}
                >
                  <option value="">Kein Mikrofon</option>
                  {microphones.map(mic => (
                    <option key={mic.deviceId} value={mic.deviceId}>
                      {mic.label || `Mikrofon ${microphones.indexOf(mic) + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={() => navigate(roomCode ? `/raum/${roomCode}/lobby` : '/kategorien')}
            >
              Überspringen
            </Button>
            <Button onClick={handleSubmit} disabled={displayName.trim().length < 2}>
              Weiter
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
