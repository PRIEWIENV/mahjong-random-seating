import { useEffect, useState } from 'react';
import docs from './generated/design-doc';
import { useLang, useText } from './i18n';

/**
 * How the draw works, in full (docs/seating-design.md).
 *
 * Generated from the document at build time rather than written again here, so the page
 * a player reads and the document an auditor reviews cannot drift apart. See
 * tools/md-to-page.js; the HTML is ours, from our own markdown, which is why it can be
 * set directly.
 *
 * This is the one destination in the app that is not a stage. UI-SPEC §1's "no tab bar"
 * is about the draw itself — signing in, submitting, waiting and the result are steps
 * of one journey and must not become sections to browse. A reference page is not a step
 * in that journey: it is beside it, reachable from anywhere and leaving the draw exactly
 * where it was.
 */

const TEXT = {
  zh: {
    back: '返回抽签',
    contents: '目录',
    top: '回到顶部',
    note: '这一页由 docs/seating-design.md 生成，和仓库里那份文档是同一份内容。',
  },
  en: {
    back: 'Back to the draw',
    contents: 'Contents',
    top: 'Back to top',
    note: 'This page is generated from docs/seating-design.md — the same document that is in the repository.',
  },
};

export default function Doc({ onBack }) {
  const lang = useLang();
  const t = useText(TEXT);
  const doc = docs[lang] || docs.en;
  const [active, setActive] = useState(null);

  // Escape leaves, like every other escapable thing in this app (UI-SPEC §7).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  // Which section the reader is in, so the contents list says where they are rather
  // than only where they could go.
  useEffect(() => {
    const headings = doc.sections
      .map((s) => document.getElementById(s.id))
      .filter(Boolean);
    if (headings.length === 0) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) setActive(visible[0].target.id);
      },
      { rootMargin: '-72px 0px -70% 0px' }
    );
    headings.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [doc]);

  return (
    <div className="stage doc">
      <nav className="doc-toc" aria-label={t.contents}>
        <p className="eyebrow">{t.contents}</p>
        <ol>
          {doc.sections.map((s) => (
            <li key={s.id} className={active === s.id ? 'on' : ''}>
              <a href={`#${s.id}`}>{s.title}</a>
            </li>
          ))}
        </ol>
        <button className="secondary doc-back" onClick={onBack}>← {t.back}</button>
      </nav>

      <article className="doc-body">
        <h1>{doc.title}</h1>
        {/* eslint-disable-next-line react/no-danger -- our own build output; see above */}
        <div dangerouslySetInnerHTML={{ __html: doc.html }} />
        <p className="fineprint doc-source">{t.note}</p>
        <button className="secondary doc-back bottom" onClick={onBack}>← {t.back}</button>
      </article>
    </div>
  );
}
