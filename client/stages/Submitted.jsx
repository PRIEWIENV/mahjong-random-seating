import { useText } from '../i18n';

/**
 * The submitted confirmation (UI-SPEC.md §5).
 *
 * "A short confirmation, not a page": the card folds shut — an envelope-seal gesture —
 * and a checkmark resolves under it. App.jsx gives way to `waiting` after ~2.5 s
 * without the player doing anything.
 *
 * The animation encodes something true (sealing), which is the test §1 sets for
 * whether an animation earns its place.
 */

const TEXT = {
  zh: {
    sealed: '已封存',
    lede: (name) => `${name}，接下来不需要你做任何事了。`,
    hint: '这个页面可以直接关掉。抽签会自动进行，结果会公布在这里。',
  },
  en: {
    sealed: 'Sealed',
    lede: (name) => `${name}, there is nothing further for you to do.`,
    hint: 'You can close this page. The draw runs on its own and the result appears here.',
  },
};

export default function Submitted({ me }) {
  const t = useText(TEXT);
  return (
    <div className="stage centre">
      <div className="card sealed" role="status" aria-live="polite">
        <div className="seal-anim" aria-hidden="true">
          <div className="envelope" />
          <svg className="tick" viewBox="0 0 48 48"><path d="M12 25l8 8 16-18" /></svg>
        </div>
        <h1>{t.sealed}</h1>
        <p className="lede">{t.lede(me?.title || '')}</p>
        <p className="hint">{t.hint}</p>
      </div>
    </div>
  );
}
