import ReactMarkdown, { type Components } from 'react-markdown';
import { publicAttachmentFileUrl } from '@/lib/api';
import styles from './markdown.module.css';

/**
 * Rendered markdown — the read-only twin of `apps/web/components/markdown.tsx`,
 * styled to match it (the owner asked this app to look like the journal),
 * but kept as a separate small component since this app stays its own
 * deployable with its own token file. Renders to real React elements, never
 * `dangerouslySetInnerHTML`, so nothing in a document's body can inject
 * markup into the page.
 *
 * `slug` resolves a `![](stem/photo.jpg)` attachment link (`format.md` §4)
 * against `apps/public-api`'s mirrored copy (`plan.md` M19) — a document
 * has no attachments of its own, so this is only ever given for an entry.
 * With no `slug`, an image link renders nothing rather than guessing at a
 * URL, the same fallback `apps/web`'s own `Markdown` takes.
 */
const baseComponents: Components = {
  h1: (props) => <h1 className={styles.h1} {...props} />,
  h2: (props) => <h2 className={styles.h2} {...props} />,
  h3: (props) => <h3 className={styles.h3} {...props} />,
  h4: (props) => <h4 className={styles.h4} {...props} />,
  h5: (props) => <h5 className={styles.h5} {...props} />,
  h6: (props) => <h6 className={styles.h6} {...props} />,
  p: (props) => <p className={styles.p} {...props} />,
  ul: (props) => <ul className={styles.list} {...props} />,
  ol: (props) => <ol className={styles.list} {...props} />,
  li: (props) => <li className={styles.listItem} {...props} />,
  blockquote: (props) => <blockquote className={styles.blockquote} {...props} />,
  hr: (props) => <hr className={styles.hr} {...props} />,
  a: (props) => <a className={styles.link} target="_blank" rel="noopener noreferrer" {...props} />,
  code: ({ className, ...props }) =>
    className ? (
      <code className={`${styles.codeBlock} ${className}`} {...props} />
    ) : (
      <code className={styles.codeInline} {...props} />
    ),
  pre: (props) => <pre className={styles.pre} {...props} />,
  strong: (props) => <strong className={styles.strong} {...props} />,
  em: (props) => <em className={styles.em} {...props} />,
};

export function Markdown({ children, slug }: { children: string; slug?: string }) {
  const components: Components = slug
    ? {
        ...baseComponents,
        img: ({ src, alt }) => {
          if (typeof src !== 'string') return null;
          const filename = src.slice(src.lastIndexOf('/') + 1);
          // eslint-disable-next-line @next/next/no-img-element -- served by apps/public-api, not Next's own image pipeline
          return <img src={publicAttachmentFileUrl(slug, filename)} alt={alt ?? ''} className={styles.image} />;
        },
      }
    : baseComponents;

  return (
    <div className={styles.root}>
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
