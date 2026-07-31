import { useEffect, useRef, useState } from 'react';
import type { SearchHit } from '@journal/contract';
import { ApiRequestError, search } from './api';

/**
 * Debounced, meaning-based search (`plan.md` M6, `requirements.md` §8) —
 * shared between the dedicated `/search` page and the home page's embedded
 * search box, which is the same feature in two places rather than two
 * features that happen to look alike.
 *
 * `result`/`failure` are each keyed by the query they answer, so a reply for
 * a query the caller has since changed away from is simply not for the
 * current query, rather than a separate "loading" flag that has to be reset
 * by hand.
 */
const SEARCH_DEBOUNCE_MS = 300;

interface Result {
  query: string;
  hits: SearchHit[];
}

interface Failure {
  query: string;
  message: string;
}

export interface UseSearchResult {
  query: string;
  setQuery: (query: string) => void;
  trimmedQuery: string;
  hits: SearchHit[] | null;
  errorMessage: string | null;
  searching: boolean;
}

export function useSearch(limit?: number): UseSearchResult {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards a reply from an earlier, slower request overwriting a later one.
  const requestId = useRef(0);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    const trimmed = query.trim();
    if (trimmed.length === 0) return;

    debounceTimer.current = setTimeout(() => {
      const id = ++requestId.current;
      search(trimmed, limit)
        .then((response) => {
          if (id !== requestId.current) return;
          setResult({ query: trimmed, hits: response.hits });
          setFailure(null);
        })
        .catch((cause: unknown) => {
          if (id !== requestId.current) return;
          setFailure({
            query: trimmed,
            message: cause instanceof ApiRequestError ? cause.message : 'Search failed.',
          });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, limit]);

  const trimmedQuery = query.trim();
  const hits = result?.query === trimmedQuery ? result.hits : null;
  const errorMessage = failure?.query === trimmedQuery ? failure.message : null;
  const searching = trimmedQuery !== '' && hits === null && errorMessage === null;

  return { query, setQuery, trimmedQuery, hits, errorMessage, searching };
}
