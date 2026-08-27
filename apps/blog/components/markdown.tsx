import ReactMarkdown, { type Components } from 'react-markdown';
import styles from './markdown.module.css';

/**
 * Rendered markdown — the read-only twin of `apps/web/components/markdown.tsx`,
 * kept as a separate small component rather than shared, per `plan.md`
 * M14's "styled independently" call for this app. Renders to real React
 * elements, never `dangerouslySetInnerHTML`, so nothing in a document's
 * body can inject markup into the page.
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
