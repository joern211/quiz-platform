// ============================================================
// Viewer Page (Watch Page wrapper)
// ============================================================

import { useParams, Navigate } from 'react-router-dom';
import { WatchPage } from './WatchPage';

export function ViewerPage() {
  const { code } = useParams();
  
  if (code) {
    return <WatchPage />;
  }
  
  return <Navigate to="/zuschauen" replace />;
}
