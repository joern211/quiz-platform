/** Early refusal of the server's action protection: nothing was executed, trying again shortly is fine. */
export const RATE_LIMITED_TEXT = 'Zu viele Aktionen in kurzer Zeit. Bitte einen Moment warten und dann erneut versuchen.';

/** Text for a failed command: the protection refusal gets its own message, everything else keeps the caller's. */
export function failureText(response: { error?: string }, fallback: string): string {
  return response.error === 'RATE_LIMITED' ? RATE_LIMITED_TEXT : fallback;
}
