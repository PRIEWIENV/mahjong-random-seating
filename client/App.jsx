import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import * as api from './api';
import { LangContext, initialLang, rememberLang, useText } from './i18n';
import SignIn from './stages/SignIn';
import Submit from './stages/Submit';
import Submitted from './stages/Submitted';
import Waiting from './stages/Waiting';
import Revealing from './stages/Revealing';
import Void from './stages/Void';
import Result from './stages/Result';

/**
 * The stage machine (UI-SPEC.md §2).
 *
 *   signin ─▶ submit ─▶ submitted ─▶ waiting ─┬─▶ revealing ─▶ result
 *                                             └─▶ void
 *
 * Stage is DERIVED, never stored: /api/status gives the draw's phase and /api/me says
 * whether this player has submitted. A player signing in after the cutoff lands
 * directly on waiting, result or void — same flow, different entry point.
 *
 * Because it is derived, a phase change on the server moves the page on its own: the
 * server pushes a status down the stream on a clock (not only when someone submits),
 * and the moment the finalisation job publishes a result the next push carries it here.
 * A player who was watching the countdown does not have to reload to see the draw.
 *
 * The one piece of genuinely local state is `justSubmitted`, the ~2.5 s confirmation.
 * It is a transient acknowledgement of something this browser just did, not a phase of
 * the draw, so it cannot come from the server.
 */
function deriveStage({ me, status, justSubmitted, revealSeen }) {
  if (!status) return 'loading';
  if (!me) return 'signin';
  if (status.phase === 'void') return 'void';
  if (status.phase === 'done') return revealSeen ? 'result' : 'result';
  if (status.phase === 'revealing') return revealSeen ? 'result' : 'revealing';
  if (justSubmitted) return 'submitted';
  if (status.phase === 'open' && !me.submitted) return 'submit';
  return 'waiting';
}

const initial = {
  status: null,
  me: null,
  meLoaded: false,
  justSubmitted: false,
  revealSeen: false,
  connection: 'connecting',
  error: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'status': return { ...state, status: action.status };
    case 'me': return { ...state, me: action.me, meLoaded: true };
    case 'signedIn': return { ...state, me: action.me, meLoaded: true, error: null };
    case 'submitted': return { ...state, me: { ...state.me, submitted: true }, justSubmitted: true };
    case 'settle': return { ...state, justSubmitted: false };
    case 'revealSeen': return { ...state, revealSeen: true };
    case 'connection': return { ...state, connection: action.connection };
    case 'signedOut': return { ...initial, status: state.status, meLoaded: true };
    case 'error': return { ...state, error: action.error };
    default: return state;
  }
}

const TEXT = {
  zh: { brand: '座位抽签', sub: 'Seating draw', signOut: '退出', lang: '切换到 English', loading: '载入中' },
  en: { brand: 'Seating draw', sub: '座位抽签', signOut: 'Sign out', lang: '切换到中文', loading: 'Loading' },
};

function Chrome({ lang, setLang, me, onSignOut, children, stage }) {
  const t = useText(TEXT);
  return (
    <>
      <header className="site">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22">
              <rect x="3" y="2" width="18" height="20" rx="3" />
              <circle cx="12" cy="9" r="2.6" className="pip" />
              <path d="M8.4 16.2h7.2" className="pip-line" />
            </svg>
          </span>
          {t.brand} <span className="en">{t.sub}</span>
        </div>
        <div className="who">
          {me && <span className="who-name">{me.title}</span>}
          <button
            className="lang-toggle"
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            title={t.lang}
            aria-label={t.lang}
          >
            <span className={lang === 'zh' ? 'on' : ''}>中</span>
            <span className={lang === 'en' ? 'on' : ''}>EN</span>
          </button>
          {me && <button className="linkish" onClick={onSignOut}>{t.signOut}</button>}
        </div>
      </header>
      {/* One <main> that cross-fades between stages. No tab bar anywhere (UI-SPEC §1). */}
      <main key={stage} className="stage-wrap">{children}</main>
    </>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [protocol, setProtocol] = useState(null);
  const [result, setResult] = useState(null);
  const [lang, setLangState] = useState(initialLang);

  const setLang = useCallback((next) => {
    setLangState(next);
    rememberLang(next);
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  }, []);
  useEffect(() => { document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'; }, [lang]);

  // Measured once at load so the countdown is driven by server time, not the client's
  // clock (UI-SPEC §5 — "so it never drifts").
  const offsetRef = useRef(0);

  useEffect(() => {
    api.getProtocol().then(setProtocol).catch(() => {});
    api.getMe().then(
      (me) => dispatch({ type: 'me', me }),
      () => dispatch({ type: 'me', me: null })
    );
    return api.subscribeStatus(
      (status) => {
        const serverMs = Date.parse(status.server_time_utc);
        if (!Number.isNaN(serverMs)) offsetRef.current = serverMs - Date.now();
        dispatch({ type: 'status', status });
      },
      (connection) => dispatch({ type: 'connection', connection })
    );
  }, []);

  const stage = deriveStage(state);

  // Fetch the result once the draw is finished, whichever way the player arrived.
  useEffect(() => {
    if ((stage === 'result' || stage === 'revealing') && !result) {
      api.getResult().then(setResult).catch(() => {});
    }
  }, [stage, result]);

  // The submitted confirmation gives way to waiting on its own (UI-SPEC §5).
  useEffect(() => {
    if (!state.justSubmitted) return;
    const t = setTimeout(() => dispatch({ type: 'settle' }), 2500);
    return () => clearTimeout(t);
  }, [state.justSubmitted]);

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  const onSignedIn = useCallback((me) => dispatch({ type: 'signedIn', me }), []);
  const onSubmitted = useCallback(() => dispatch({ type: 'submitted' }), []);
  const onRevealDone = useCallback(() => dispatch({ type: 'revealSeen' }), []);
  const onSignOut = useCallback(
    () => api.signOut().then(() => dispatch({ type: 'signedOut' })),
    []
  );

  const body = useMemo(() => {
    switch (stage) {
      case 'loading':
        return <div className="stage centre"><div className="spinner" /></div>;
      case 'signin':
        return <SignIn status={state.status} onSignedIn={onSignedIn} />;
      case 'submit':
        return <Submit protocol={protocol} status={state.status} me={state.me} onSubmitted={onSubmitted} />;
      case 'submitted':
        return <Submitted me={state.me} />;
      case 'waiting':
        return <Waiting status={state.status} me={state.me} serverNow={serverNow} connection={state.connection} />;
      case 'revealing':
        return <Revealing status={state.status} result={result} onDone={onRevealDone} />;
      case 'void':
        return <Void status={state.status} />;
      case 'result':
        return <Result status={state.status} me={state.me} result={result} />;
      default:
        return null;
    }
  }, [stage, state, protocol, result, serverNow, onSignedIn, onSubmitted, onRevealDone]);

  return (
    <LangContext.Provider value={lang}>
      <Chrome lang={lang} setLang={setLang} me={state.me} onSignOut={onSignOut} stage={stage}>
        {body}
      </Chrome>
    </LangContext.Provider>
  );
}
