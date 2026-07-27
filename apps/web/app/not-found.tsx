import Link from 'next/link';
import { Notice } from '@/components/notice';

export default function NotFound() {
  return (
    <Notice title="There is no entry here.">
      <Link href="/">Back to the most recent entries</Link>
    </Notice>
  );
}
