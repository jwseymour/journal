import ReactMarkdown, { type Components } from 'react-markdown';
import { attachmentFileUrl } from '@/lib/api';
import styles from './markdown.module.css';

/**
 * Rendered markdown (`design.md` §5.1, `requirements.md` §4.8).
 *
 * "Markdown is not a convention the user is asked to follow — it is simply
 * respected where it appears." So this renders whatever valid CommonMark
 * exists and leaves everything else as the plain text it is; there is no GFM
 * extension, no autolinking beyond what CommonMark itself defines, nothing
 * that would make the renderer smarter than the format actually promises.
 *
 * `react-markdown` renders to real React elements rather than
 * `dangerouslySetInnerHTML`, so nothing written in an entry can inject markup
 * into the page — safe by construction, not by a sanitising pass bolted on
 * after the fact.
 *
 * The element styling lives entirely in `markdown.module.css`, token-driven,
 * so the read view and the composer's rendered-preview mode (`⌘⇧P`) share
 * one definition of what a heading, a list, a quote look like — "one
 * coherent style" (`design.md` §1.3) applied to the one thing in the app
 * that has document structure at all.
 *
 * `![](stem/photo.jpg)` — an attachment link (`format.md` §4) — resolves
 * through `entryId`, not the `stem` fragment the link itself carries: the
 * link is written to resolve in a plain markdown viewer with no application
 * involved (`requirements.md` §4.6), but this renderer has an API to call,
 * so it only ever needs the filename off the end. Given with no `entryId`
 * (nothing calls it that way today, but nothing requires one either) an
 * image link simply renders nothing, rather than guessing at a URL.
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
      // A fenced block: `react-markdown` puts the language on this inner
      // <code>, and the surrounding <pre> below handles the block framing.
      <code className={`${styles.codeBlock} ${className}`} {...props} />
    ) : (
      <code className={styles.codeInline} {...props} />
    ),
  pre: (props) => <pre className={styles.pre} {...props} />,
  strong: (props) => <strong className={styles.strong} {...props} />,
  em: (props) => <em className={styles.em} {...props} />,
};

export function Markdown({ children, entryId }: { children: string; entryId?: string }) {
  const components: Components = entryId
    ? {
        ...baseComponents,
        img: ({ src, alt }) => {
          if (typeof src !== 'string') return null;
          const filename = src.slice(src.lastIndexOf('/') + 1);
          // eslint-disable-next-line @next/next/no-img-element -- served by the API, not Next's own image pipeline
          return <img src={attachmentFileUrl(entryId, filename)} alt={alt ?? ''} className={styles.image} />;
        },
      }
    : baseComponents;

  return (
    <div className={styles.root}>
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
