import { notFound } from 'next/navigation';
import type { Document } from '@journal/contract';
import { Notice } from '@/components/notice';
import { ApiRequestError, getDocument } from '@/lib/api';
import { DocumentView } from './document-view';

export const dynamic = 'force-dynamic';

/** One document: read by default, with a minimal way to edit (`requirements.md` §9, `plan.md` M12). */
export default async function DocumentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let document: Document | null;
  try {
    document = await getDocument(id);
  } catch (error) {
    return (
      <Notice title="That document could not be read." tone="danger">
        {error instanceof ApiRequestError ? error.message : 'Something went wrong.'}
      </Notice>
    );
  }

  if (!document) notFound();

  return <DocumentView document={document} />;
}
