// ============================================================
// UI Components - Main Export
// ============================================================

// Theme Provider
export { ThemeProvider, useTheme } from './providers/ThemeProvider';
export {
  ACCENTS,
  APPEARANCE_KEY,
  LEGACY_THEME_KEY,
  DEFAULT_ACCENT,
  DEFAULT_APPEARANCE,
  accentLabel,
  parseAppearance,
  serializeAppearance,
  readAppearance,
  writeAppearance,
  applyAppearance,
  type Accent,
  type Appearance,
  type Theme,
} from './providers/appearance';

// Design System Components
export { Button, ButtonLink } from './components/Button';
export { Card } from './components/Card';
export { Input } from './components/Input';
export { Badge } from './components/Badge';
export { Modal } from './components/Modal';
export { ConfirmDialog } from './components/ConfirmDialog';
export { Spinner } from './components/Spinner';

// Layout Components
export { Logo } from './components/Logo';

// Game Components (from web app)
export { Timer } from './components/Timer';
export { BuzzerButton } from './components/BuzzerButton';
export { InfoPopup } from './components/InfoPopup';
