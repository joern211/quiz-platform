// ============================================================
// App Component – v0.2.1 (Clean routes, no redirect loops)
// ============================================================

import { Routes, Route, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useTheme } from '@quiz/ui';

// Layout
import { Header } from './components/layout/Header';
import { Footer } from './components/layout/Footer';

// Pages
import { HomePage }        from './pages/HomePage';
import { CategoriesPage }  from './pages/CategoriesPage';
import { CategoryPage }    from './pages/CategoryPage';
import { GamePage }        from './pages/GamePage';
import { ModeratorLoginPage }  from './pages/ModeratorLoginPage';
import { ModeratorSetupPage }  from './pages/ModeratorSetupPage';
import { ModeratorLobbyPage }  from './pages/ModeratorLobbyPage';
import { ModeratorGamePage }   from './pages/ModeratorGamePage';
import { ModeratorResultPage } from './pages/ModeratorResultPage';
import { JoinPage }        from './pages/JoinPage';
import { PlayerLobbyPage } from './pages/PlayerLobbyPage';
import { PlayerGamePage }  from './pages/PlayerGamePage';
import { PlayerResultPage } from './pages/PlayerResultPage';
import { ViewerPage }          from './pages/ViewerPage';
import { ViewerLobbyPage }     from './pages/ViewerLobbyPage';
import { ViewerGamePage }      from './pages/ViewerGamePage';
import { ViewerResultPage }    from './pages/ViewerResultPage';
import { RoomsPage }       from './pages/RoomsPage';
import { ProfilePage }     from './pages/ProfilePage';
import { AdminPage }       from './pages/AdminPage';
import { NotFoundPage }    from './pages/NotFoundPage';

export default function App() {
  const { theme } = useTheme();
  const location = useLocation();

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Scroll to top on route change (respects prefers-reduced-motion)
  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: prefersReduced ? 'instant' : 'smooth' });
  }, [location.pathname]);

  return (
    <div className="app">
      <Header />
      <main key={location.pathname}>
        <Routes>
          {/* ── Öffentliche Startseite ── */}
          <Route path="/"                        element={<HomePage />} />
          <Route path="/kategorien"              element={<CategoriesPage />} />
          <Route path="/kategorie/:categorySlug" element={<CategoryPage />} />
          <Route path="/spiel/:gameSlug"         element={<GamePage />} />
          <Route path="/beitreten"               element={<JoinPage />} />
          <Route path="/raeume"                  element={<RoomsPage />} />

          {/* ── Moderator ── */}
          <Route path="/moderator/anmelden"                              element={<ModeratorLoginPage />} />
          <Route path="/moderator/vorbereitung/:gameSlug"                element={<ModeratorSetupPage />} />
          <Route path="/moderator/raum/:code/lobby"                      element={<ModeratorLobbyPage />} />
          <Route path="/moderator/raum/:code/spiel"                      element={<ModeratorGamePage />} />
          <Route path="/moderator/raum/:code/ergebnis"                   element={<ModeratorResultPage />} />

          {/* ── Spieler ── */}
          <Route path="/raum/:code/lobby"     element={<PlayerLobbyPage />} />
          <Route path="/raum/:code/spiel"     element={<PlayerGamePage />} />
          <Route path="/raum/:code/ergebnis"  element={<PlayerResultPage />} />

          {/* ── Zuschauer ── */}
          <Route path="/zuschauen"                        element={<ViewerPage />} />
          <Route path="/zuschauen/:code/lobby"            element={<ViewerLobbyPage />} />
          <Route path="/zuschauen/:code/spiel"            element={<ViewerGamePage />} />
          <Route path="/zuschauen/:code/ergebnis"         element={<ViewerResultPage />} />

          {/* ── Profil / Admin ── */}
          <Route path="/spieler/profil" element={<ProfilePage />} />
          <Route path="/admin/*"       element={<AdminPage />} />

          {/* ── 404 ── */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
