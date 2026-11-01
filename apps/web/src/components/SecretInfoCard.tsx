// ============================================================
// N5 — SecretInfoCard: reusable, private display of the fragments released to THIS participant (Midnight design)
//
// Responsibility: show ONLY the information the server has already released to this participant (`projection.own`),
// behind a deliberate "Anzeigen" / "Verbergen" toggle. It owns no socket, session, command, timer or read receipt and it
// is NOT a submit form: there is no SUBMITTED / LOCKED / ACK state machine and nothing is sent back. It never receives the
// deal, a role map, recipient lists or any ACL object — only the client-safe projection contract plus the context the
// embedding UI EXPECTS (run, round, deal, revision, recipient) from its own authenticated session.
//
// Binding BEFORE rendering: the projection is validated with the strict client schema and compared with the expected
// context while rendering. A foreign, stale, malformed or private-part-less projection (another run / round / deal /
// revision / participant, a viewer or display projection, a withdrawn one) is never rendered as content: no text from it
// reaches the markup, not even for one frame. An effect that resets afterwards would be too late and is not relied upon.
//
// Hiding is protection against casual over-the-shoulder reading ONLY. The data were already delivered to this authorised
// browser; hiding is no server-side access control and does not undo anything the participant has seen. While hidden, the
// texts are not in the DOM at all (no CSS-only hiding, no aria-label, title or data attribute). The collapsed state is the
// same for zero, one and many fragments, so the label itself reveals nothing.
//
// Reset: the open/closed state is keyed by the expected context (+ a content fingerprint that never reaches the DOM).
// ANY change of that key — another run, round, deal, revision or recipient, a withdrawn projection, changed content —
// starts hidden again; returning to an earlier key never resurrects an old "open". A mere parent re-render, a new but
// equal props wrapper or a theme / accent change keeps the key and therefore the state.
//
// Only plain text is rendered (React text nodes; multi-line text keeps its line breaks). No timer, no animation, no audio,
// no live region and no automatic read-out of secrets; the focus stays on the toggle button.
// ============================================================

import { useId, useState } from 'react';
import { Button } from '@quiz/ui';
import {
  parseSecretInfoProjection, secretInfoContextKey, secretInfoProjectionMatches,
  type SecretInfoExpectedContext, type SecretInfoProjection,
} from '@quiz/shared/secretInfo';
import styles from './SecretInfoCard.module.css';

export interface SecretInfoCardProps {
  /** The context THIS caller expects, from its own authenticated server session — never taken from the projection. */
  expected: SecretInfoExpectedContext;
  /** The projection received for this viewer; null / undefined when there is none (withdrawn, missing, other role). */
  projection: SecretInfoProjection | null | undefined;
  /** Neutral heading. Must not name a role or a game rule. */
  title?: string;
}

const UNAVAILABLE = 'Zurzeit sind für dich keine Informationen verfügbar.';
const NO_FRAGMENTS = 'Für dich liegen aktuell keine Informationen vor.';
const HINT = 'Nur für dich bestimmt. Schütze deinen Bildschirm vor neugierigen Blicken.';

interface Disclosure { key: string | null; open: boolean }

export function SecretInfoCard({ expected, projection, title = 'Geheime Informationen' }: SecretInfoCardProps) {
  const id = useId();
  const titleId = `${id}-title`, panelId = `${id}-panel`;

  // Bind first: only a strictly valid projection that matches the expected context exactly may reach the markup.
  const parsed = projection ? parseSecretInfoProjection(projection) : null;
  const usable = parsed !== null && parsed.ok && secretInfoProjectionMatches(parsed.projection, expected) ? parsed.projection : null;
  const fragments = usable?.own?.fragments ?? [];
  const key = usable ? `${secretInfoContextKey(expected)}|${JSON.stringify(fragments)}` : null;

  const [disclosure, setDisclosure] = useState<Disclosure>({ key, open: false });
  let current = disclosure;
  if (current.key !== key) { current = { key, open: false }; setDisclosure(current); } // derived while rendering: no extra frame with old content
  const open = key !== null && current.open;

  if (!usable) {
    return (
      <section className={styles.card} aria-labelledby={titleId}>
        <h3 id={titleId} className={styles.title}>{title}</h3>
        <p className={styles.status}>{UNAVAILABLE}</p>
      </section>
    );
  }

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.title}>{title}</h3>
      <p className={styles.hint}>{HINT}</p>
      <Button
        type="button"
        variant="secondary"
        size="lg"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setDisclosure({ key, open: !open })}
      >
        {open ? 'Verbergen' : 'Anzeigen'}<span className={styles.srOnly}> – {title}</span>
      </Button>
      <div id={panelId} className={styles.panel}>
        {open && (fragments.length === 0
          ? <p className={styles.empty}>{NO_FRAGMENTS}</p>
          : (
            <ul className={styles.list}>
              {fragments.map((fragment, index) => (
                <li key={index} className={styles.fragment}>
                  <h4 className={styles.fragmentTitle}>{fragment.title}</h4>
                  <p className={styles.fragmentText}>{fragment.text}</p>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </section>
  );
}
