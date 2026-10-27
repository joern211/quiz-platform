import { useParams } from 'react-router-dom';
import { ResultScreen } from '../components/ResultScreen';
export function ViewerResultPage() {
  const { code = '' } = useParams<{ code: string }>();
  return <ResultScreen roomCode={code} role="VIEWER" />;
}
