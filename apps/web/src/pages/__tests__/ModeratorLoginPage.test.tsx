/**
 * Integration test: ModeratorLoginPage navigates with validated URL after login.
 *
 * Spies on React Router's useNavigate by mocking the entire react-router-dom module.
 * The mock returns vi.fn() for useNavigate, which allows full call tracking.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock react-router-dom BEFORE importing the component ─────────────────────
const mockNavFn = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavFn,
  };
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

import { ModeratorLoginPage } from '../ModeratorLoginPage';

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockNavFn.mockReset();
  mockNavFn.mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ModeratorLoginPage', () => {
  function mockLoginSuccess(userId = 'mod-1', displayName = 'TestModerator') {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { user: { id: userId, displayName, role: 'MODERATOR' } },
        }),
    });
  }

  function mockLoginFailure(message = 'Ungültige Anmeldedaten.') {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () =>
        Promise.resolve({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message },
        }),
    });
  }

  function mockNetworkError() {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
  }

  function renderWithReturn(returnParam = '') {
    const entry = returnParam
      ? `/moderator/anmelden?${returnParam}`
      : '/moderator/anmelden';
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <ModeratorLoginPage />
      </MemoryRouter>
    );
  }

  async function submitLogin() {
    await userEvent.type(screen.getByLabelText(/benutzername/i), 'admin');
    await userEvent.type(screen.getByLabelText(/passwort/i), 'password123');
    await userEvent.click(screen.getByRole('button', { name: /anmelden/i }));
  }

  // ── Safe internal return URL ─────────────────────────────────────────────
  it('navigates to /kategorien for safe internal return URL', async () => {
    mockLoginSuccess();
    renderWithReturn('return=/kategorien');
    await submitLogin();
    await waitFor(() => {
      expect(mockNavFn).toHaveBeenCalledWith('/kategorien', { replace: true });
    });
    expect(mockNavFn).toHaveBeenCalledTimes(1);
  });

  it('navigates to / when return param is root path', async () => {
    mockLoginSuccess();
    renderWithReturn('return=/');
    await submitLogin();
    await waitFor(() => {
      expect(mockNavFn).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('navigates to internal geo setup path when return param is set', async () => {
    mockLoginSuccess();
    renderWithReturn('return=/moderator/vorbereitung/geo');
    await submitLogin();
    await waitFor(() => {
      expect(mockNavFn).toHaveBeenCalledWith('/moderator/vorbereitung/geo', { replace: true });
    });
  });

  // ── Unsafe/external URL → falls back to /kategorien ─────────────────────
  it('falls back to /kategorien for https external URL', async () => {
    mockLoginSuccess();
    renderWithReturn('return=https://evil.com/redirect');
    await submitLogin();
    await waitFor(() => {
      expect(mockNavFn).toHaveBeenCalledWith('/kategorien', { replace: true });
    });
  });

  it('falls back to /kategorien for protocol-relative // URL', async () => {
    mockLoginSuccess();
    renderWithReturn('return=//evil.com/redirect');
    await submitLogin();
    await waitFor(() => {
      expect(mockNavFn).toHaveBeenCalledWith('/kategorien', { replace: true });
    });
  });

  it('falls back to /kategorien for double-encoded external URL', async () => {
    mockLoginSuccess();
    renderWithReturn('return=%2F%2Fevil.com%2Fredirect');
    await submitLogin();
    await waitFor(() => {
      expect(mockNavFn).toHaveBeenCalledWith('/kategorien', { replace: true });
    });
  });

  it('falls back to /kategorien when no return param is present', async () => {
    mockLoginSuccess();
    renderWithReturn();
    await submitLogin();
    await waitFor(() => {
      expect(mockNavFn).toHaveBeenCalledWith('/kategorien', { replace: true });
    });
  });

  // ── Failed login ─────────────────────────────────────────────────────────
  it('shows error message and does NOT navigate on failed login', async () => {
    mockLoginFailure();
    renderWithReturn();
    await submitLogin();
    await waitFor(() => {
      expect(screen.getByText(/ungültige anmeldedaten/i)).toBeInTheDocument();
    });
    expect(mockNavFn).not.toHaveBeenCalled();
  });

  it('shows connection error and does NOT navigate on network failure', async () => {
    mockNetworkError();
    renderWithReturn();
    await submitLogin();
    await waitFor(() => {
      expect(screen.getByText(/verbindungsfehler/i)).toBeInTheDocument();
    });
    expect(mockNavFn).not.toHaveBeenCalled();
  });


});
