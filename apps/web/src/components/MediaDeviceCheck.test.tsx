import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaDeviceCheck } from './MediaDeviceCheck';
const capture = vi.fn(), enumerate = vi.fn();
function stream(id: string) {
  const stop = vi.fn(); const listeners = new Map<string, () => void>();
  const track = { stop, getSettings: () => ({ deviceId: id }), addEventListener: (name: string, callback: () => void) => listeners.set(name, callback) };
  return { value: { getTracks: () => [track] } as unknown as MediaStream, stop, end: () => listeners.get('ended')?.() };
}
async function open() { await userEvent.click(screen.getByText('Geräte vorab testen (optional)')); }
beforeEach(() => {
  capture.mockReset(); enumerate.mockReset(); enumerate.mockResolvedValue([]); localStorage.clear();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: capture, enumerateDevices: enumerate, addEventListener: vi.fn(), removeEventListener: vi.fn() } });
});
afterEach(() => { vi.unstubAllGlobals(); });
it('requests no hardware on mount or opening, isolates microphone denial, and stops the independent camera on unmount', async () => {
  const camera = stream('camera-1');
  capture.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError')).mockResolvedValueOnce(camera.value);
  const view = render(<StrictMode><MediaDeviceCheck /></StrictMode>); await open();
  expect(capture).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Mikrofon testen' }));
  expect(screen.getByRole('status')).toHaveTextContent('Freigabe verweigert. Du kannst trotzdem beitreten.');
  await userEvent.click(screen.getByRole('button', { name: 'Kamera testen' }));
  expect(capture.mock.calls[0][0]).toMatchObject({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  expect(capture.mock.calls[1][0]).toMatchObject({ audio: false, video: { width: { ideal: 640 } } });
  expect(screen.getByLabelText('Lokale Kameravorschau')).toHaveProperty('srcObject', camera.value);
  view.unmount(); expect(camera.stop).toHaveBeenCalledTimes(1);
});
it('disposes a late permission result after cancellation and preserves the newer camera', async () => {
  const oldCamera = stream('old'), newCamera = stream('new'); let resolve!: (s: MediaStream) => void;
  capture.mockReturnValueOnce(new Promise<MediaStream>(done => { resolve = done; })).mockResolvedValueOnce(newCamera.value);
  render(<MediaDeviceCheck />); await open();
  await userEvent.click(screen.getByRole('button', { name: 'Kamera testen' }));
  await userEvent.click(screen.getByRole('button', { name: 'Test stoppen' }));
  await userEvent.click(screen.getByRole('button', { name: 'Kamera testen' }));
  await act(async () => resolve(oldCamera.value));
  expect(oldCamera.stop).toHaveBeenCalledOnce(); expect(newCamera.stop).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Lokale Kameravorschau')).toHaveProperty('srcObject', newCamera.value);
});
it('disposes permission results arriving after navigation', async () => {
  const camera = stream('late'); let resolve!: (s: MediaStream) => void;
  capture.mockReturnValue(new Promise<MediaStream>(done => { resolve = done; }));
  const view = render(<MediaDeviceCheck />); await open(); await userEvent.click(screen.getByRole('button', { name: 'Kamera testen' })); view.unmount();
  await act(async () => resolve(camera.value)); expect(camera.stop).toHaveBeenCalledOnce();
});
it('falls back only when a remembered device is missing and retains filters without enabling capture', async () => {
  localStorage.setItem('qp:media-devices:v1', JSON.stringify({ audioDevice: 'removed', echoCancellation: false }));
  const microphone = stream('available');
  capture.mockRejectedValueOnce(new DOMException('missing', 'OverconstrainedError')).mockResolvedValueOnce(microphone.value);
  render(<MediaDeviceCheck />); await open();
  expect(screen.getByLabelText('Echounterdrückung')).not.toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'Mikrofon testen' }));
  expect(capture.mock.calls[0][0].audio.deviceId).toEqual({ exact: 'removed' });
  expect(capture.mock.calls[1][0].audio).not.toHaveProperty('deviceId');
  expect(capture.mock.calls[1][0].audio.echoCancellation).toBe(false);
  expect(screen.getByRole('status')).toHaveTextContent('Standardgerät wird verwendet');
  await act(async () => microphone.end());
  expect(microphone.stop).toHaveBeenCalledOnce(); expect(screen.queryByLabelText('Mikrofonpegel')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Gerät getrennt');
});
it('stops hidden preview on collapse and never offers a viewer microphone', async () => {
  const camera = stream('camera'); capture.mockResolvedValue(camera.value);
  render(<MediaDeviceCheck microphone={false} />); await open();
  expect(screen.queryByRole('button', { name: 'Mikrofon testen' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Kamera testen' }));
  const details = screen.getByText('Geräte vorab testen (optional)').closest('details')!;
  details.open = false; fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(camera.stop).toHaveBeenCalledOnce());
});
it('still renders without media APIs or valid saved settings', async () => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  localStorage.setItem('qp:media-devices:v1', 'broken');
  render(<MediaDeviceCheck />); await open();
  expect(screen.getByRole('status')).toHaveTextContent('Du kannst trotzdem beitreten');
  expect(screen.getByRole('button', { name: 'Kamera testen' })).toBeDisabled();
});
