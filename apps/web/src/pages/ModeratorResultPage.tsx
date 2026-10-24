import { useParams } from 'react-router-dom';
import { ResultScreen } from '../components/ResultScreen';
export function ModeratorResultPage() {
  const { code = '' } = useParams<{ code: string }>();
  return <ResultScreen roomCode={code} role="HOST" />;
}
