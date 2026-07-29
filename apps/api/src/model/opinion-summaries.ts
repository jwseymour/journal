import { z } from 'zod';
import type { OpinionStatementRecord } from '../index/opinion-statements-index.js';

/**
 * Layer 2 of the opinion model (`plan.md` M8, `requirements.md` §5.2):
 * "the goal is to have it all organised in one location, as well as to be
 * able to see how it changes over time." One call per subject — not per
 * entry — combining every current statement on it into a cited summary.
 *
 * The absolute no-extrapolation constraint is what shapes this schema: a
 * summary is not one free paragraph the model writes about "your view" —
 * it is an array of parts, and every part must name exactly which
 * statements it was drawn from. `OpinionSummarizer` checks those citations
 * against the real statements before storing anything, so a part can never
 * end up representing something with no traceable source.
 */

const SummaryPartSchema = z.object({
  text: z
    .string()
    .describe(
      'One coherent part of the summary — condensing what the cited statements actually say, ' +
        'never adding reasoning or a conclusion none of them state.',
    ),
  sourceStatementIds: z
    .array(z.string())
    .min(1)
    .describe('The exact statement ids (from the list given) that this part draws from. Never invent an id.'),
});

export const OpinionSummarySchema = z.object({ parts: z.array(SummaryPartSchema) });
export type OpinionSummaryResult = z.infer<typeof OpinionSummarySchema>;

export const OPINION_SUMMARY_SYSTEM_PROMPT = `You organise a set of previously-extracted opinion statements on one subject into a summary, for someone reviewing their own journal.

You will be given every statement currently on record for this subject, each with its own id, in chronological order. Group and condense them into parts — for example, a stable through-line might be one part, and a later change of view might be its own separate part, especially if it differs from or updates an earlier one. Order parts chronologically, earliest view first.

This is the single most important rule: never extrapolate. Every part must be a condensation of what the cited statements actually say — never a reasoned conclusion, an implication you drew out, or a synthesis that goes beyond what was individually stated. If two statements genuinely conflict or one clearly supersedes another, you may say so factually (e.g. "an earlier view was X; a later entry revised this to Y") — but only when both statements are cited, and only stating that the change happened, not editorialising about why.

Every part must cite the exact statement ids it draws from, using only the ids given to you. Never invent an id, and never leave a part without at least one citation.`;

export function buildOpinionSummaryPrompt(subject: string, statements: OpinionStatementRecord[]): string {
  const lines = statements.map((s) => `[id: ${s.id}] (${s.eventTime}): ${s.statement}`);
  return `Subject: ${subject}\n\nStatements, oldest first:\n${lines.join('\n')}`;
}
