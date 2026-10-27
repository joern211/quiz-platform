import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ContentMedia } from './ContentMedia';
import { ContentMediaFields } from './ContentMediaFields';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('uses protected image URLs, reports failure neutrally and requests a refreshed projection on retry', async () => {
  const refresh = vi.fn(); render(<ContentMedia mediaUrl="/api/v1/media/test?sig=short" mediaType="image" onRefresh={refresh} />);
  const img = screen.getByRole('img', { name: 'Bild zur Frage' }); expect(img).toHaveAttribute('src', '/api/v1/media/test?sig=short');
  fireEvent.error(img); expect(screen.getByRole('status')).toHaveTextContent('gerade nicht geladen');
  await userEvent.click(screen.getByRole('button', { name: 'Medium erneut laden' }));
  expect(refresh).toHaveBeenCalledTimes(1); expect(screen.getByRole('img')).toBeInTheDocument();
});
it('never autoplays question audio and does not request an absent or future asset', () => {
  const { rerender, container } = render(<ContentMedia mediaType="image" />); expect(container).toBeEmptyDOMElement();
  rerender(<ContentMedia mediaUrl="/api/v1/media/audio?sig=short" mediaType="audio" />);
  const audio = screen.getByLabelText('Audio zur Frage'); expect(audio).toHaveAttribute('controls'); expect(audio).not.toHaveAttribute('autoplay');
});
it('uploads privately with the real multipart contract and resets prior media rights on replacement', async () => {
  const changed = vi.fn(), fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'job-1', status: 'QUEUED' } }) }).mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { id: 'job-1', status: 'READY', asset: { id: 'new-asset', type: 'image' } } }) });
  vi.stubGlobal('fetch', fetch);
  render(<ContentMediaFields item={null} payload={{ mediaAssetId: 'old-asset', mediaRights: { license: 'Old license' } }} disabled={false} onChange={changed} />);
  const file = new File(['png'], 'new.png', { type: 'image/png' }); await userEvent.upload(screen.getByLabelText('Medium hochladen'), file);
  expect(fetch).toHaveBeenCalledWith('/api/v1/media/jobs', expect.objectContaining({ method: 'POST', credentials: 'include', body: expect.any(FormData) }));
  expect((fetch.mock.calls[0][1].body as FormData).get('file')).toEqual(file);
  expect((fetch.mock.calls[0][1].body as FormData).get('commandId')).toMatch(/^[a-f0-9-]{36}$/);
  await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ mediaAssetId: 'new-asset', mediaType: 'image', mediaRights: expect.objectContaining({ license: '', ownMaterial: false }) })));
});
