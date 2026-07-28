import ReactMarkdown, { type Components } from 'react-markdown';
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
 */

const components: Components = {
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

export function Markdown({ children }: { children: string }) {
  return (
    <div className={styles.root}>
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
