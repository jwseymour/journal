'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChartSpec, ChatMessage } from '@journal/contract';
import { ApiRequestError, chat } from '@/lib/api';
import { MessageTurn } from '@/components/chat/message-turn';
import styles from './page.module.css';

/**
 * The chat feature ("further features", `requirements.md` §8) — ask
 * questions about metrics, reviews, and lists, and get back an answer plus
 * data-driven charts.
 *
 * Ephemeral by design: nothing about the conversation is stored behind the
 * API, so this component holds the entire conversation itself and resends
 * it in full on every turn (`lib/api.ts#chat`). There is no server state to
 * lose on reload, and nothing here to reconcile with a backend session.
 *
 * All aggregation, tool selection, and chart construction happen behind
 * `POST /chat` (`requirements.md` §7.1) — this page only ever renders
 * `ChatResponse` exactly as given.
 */

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  charts?: ChartSpec[];
  citedEntryIds?: string[];
}

/** Mirrors `MAX_CHAT_MESSAGES` in `http/app.ts` — kept as a plain duplicated
 * constant, the same way `DEFAULT_WINDOW_DAYS` is duplicated across backend
 * files, rather than exported from `@journal/contract`, which is
 * deliberately types-only and emits no runtime code. Checked client-side
 * only so hitting the cap reads as "start a new chat" rather than a raw
 * validation error from the server. */
const MAX_CHAT_MESSAGES = 40;

export default function ChatPage() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards a reply from an earlier, slower request overwriting a later one
  // — the same pattern `search/page.tsx` uses.
  const requestId = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [turns, sending]);

  // Ephemeral means there is nowhere to trim history to — reloading the
  // page for a fresh conversation is the only sensible answer here.
  const atCapacity = turns.length >= MAX_CHAT_MESSAGES;

  const send = () => {
    const content = draft.trim();
    if (content === '' || sending || atCapacity) return;

    const nextTurns: ChatTurn[] = [...turns, { role: 'user', content }];
    setTurns(nextTurns);
    setDraft('');
    setError(null);
    setSending(true);

    const id = ++requestId.current;
    chat(nextTurns.map(({ role, content: turnContent }): ChatMessage => ({ role, content: turnContent })))
      .then((response) => {
        if (id !== requestId.current) return;
        setTurns((current) => [
          ...current,
          { role: 'assistant', content: response.answer, charts: response.charts, citedEntryIds: response.citedEntryIds },
        ]);
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return;
        setError(cause instanceof ApiRequestError ? cause.message : 'Could not get an answer.');
      })
      .finally(() => {
        if (id !== requestId.current) return;
        setSending(false);
      });
  };

  return (
    <div className={styles.page}>
      {turns.length === 0 && (
        <p className={styles.hint}>
          Ask about your metrics, reviews, or lists — for example, &ldquo;how much have I exercised recently&rdquo; or
          &ldquo;what are my top-rated films&rdquo;.
        </p>
      )}

      <div className={styles.turns}>
        {turns.map((turn, index) => (
          <MessageTurn
            key={index}
            role={turn.role}
            content={turn.content}
            charts={turn.charts}
            citedEntryIds={turn.citedEntryIds}
          />
        ))}
        {sending && <p className={styles.thinking}>Thinking…</p>}
        <div ref={bottomRef} />
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {atCapacity ? (
        <p className={styles.hint}>This conversation has reached its limit — reload the page to start a new one.</p>
      ) : (
        <div className={styles.composer}>
          <textarea
            className={styles.textarea}
            placeholder="Ask a question"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter submits, Shift+Enter inserts a newline — bound locally
              // rather than in the global scheme, the same reasoning
              // `lib/keyboard.tsx` gives for the entry composer's own bindings:
              // this must work while the hands are in the text.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            autoFocus
            aria-label="Ask a question"
          />
          <button type="button" className={styles.sendButton} onClick={send} disabled={sending || draft.trim() === ''}>
            Ask
          </button>
        </div>
      )}
    </div>
  );
}
