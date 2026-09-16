// ============================================================
// Main App Component with Routing
// ============================================================

import { Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import { useTheme } from '@quiz/ui';

// Layout
import { Header } from './components/layout/Header';
import { Footer } from './components/layout/Footer';

// Pages
import { HomePage } from './pages/HomePage';
import { CategoriesPage } from './pages/CategoriesPage';
import { CategoryPage } from './pages/CategoryPage';
import { GamePage } from './pages/GamePage';
import { ModeratorLoginPage } from './pages/ModeratorLoginPage';
import { ModeratorSetupPage } from './pages/ModeratorSetupPage';
import { ModeratorLobbyPage } from './pages/ModeratorLobbyPage';
import { ModeratorGamePage } from './pages/ModeratorGamePage';
import { JoinPage } from './pages/JoinPage';
import { PlayerLobbyPage } from './pages/PlayerLobbyPage';
import { PlayerGamePage } from './pages/PlayerGamePage';
import { ViewerPage } from './pages/ViewerPage';
import { RoomsPage } from './pages/RoomsPage';
import { ProfilePage } from './pages/ProfilePage';
import { AdminPage } from './pages/AdminPage';
import { NotFoundPage } from './pages/NotFoundPage';

export default function App() {
  const { theme } = useTheme();

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="app">
      <Header />
      <main className="page">
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<HomePage />} />
          <Route path="/kategorien" element={<CategoriesPage />} />
          <Route path="/kategorie/:categorySlug" element={<CategoryPage />} />
          <Route path="/spiel/:gameSlug" element={<GamePage />} />
          <Route path="/beitreten" element={<JoinPage />} />
          <Route path="/raeume" element={<RoomsPage />} />
          <Route path="/zuschauen" element={<ViewerPage />} />
          <Route path="/zuschauen/:code" element={<ViewerPage />} />

          {/* Moderator routes */}
          <Route path="/moderator/anmelden" element={<ModeratorLoginPage />} />
          <Route path="/moderator/vorbereitung/:gameSlug" element={<ModeratorSetupPage />} />
          <Route path="/moderator/raum/:code/lobby" element={<ModeratorLobbyPage />} />
          <Route path="/moderator/raum/:code/spiel" element={<ModeratorGamePage />} />

          {/* Player routes */}
          <Route path="/raum/:code/lobby" element={<PlayerLobbyPage />} />
          <Route path="/raum/:code/spiel" element={<PlayerGamePage />} />

          {/* Profile */}
          <Route path="/spieler/profil" element={<ProfilePage />} />

          {/* Admin */}
          <Route path="/admin/*" element={<AdminPage />} />

          {/* 404 */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
