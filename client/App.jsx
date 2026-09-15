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
import Doc from './Doc';

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
 *
 * `view` is the other piece, and it is not a stage either. The explanation page sits
 * beside the draw rather than inside it: opening it leaves the stage machine exactly
 * where it was, and closing it returns to whatever the draw has become meanwhile.
 */
function deriveStage({ me, status, justSubmitted, revealSeen }) {
  if (!status) return 'loading';
  if (!me) return 'signin';
  if (status.phase === 'void') return 'void';
  // No reveal animation for a phase that is already over. A player who arrives after the
  // draw is not being kept in suspense about something everyone else has seen; the
  // animation belongs to the transition, which is the 'revealing' phase below.
  if (status.phase === 'done') return 'result';
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

/**
 * The app's name, with the event's own name in front of it when Pantheon has told us
 * one. A club runs several events a year and a player may have two of these open; a
 * page that only says "Seating draw" cannot be told apart from last month's.
 */
const TEXT = {
  zh: {
    brand: '座位抽签',
    branded: (event) => `${event}座位抽签`,
    sub: 'Seating draw',
    signOut: '退出',
    lang: '切换到 English',
    loading: '载入中',
    navDraw: '抽签',
    navDoc: '原理',
    navLabel: '页面',
    adminPanel: '组织者面板',
  },
  en: {
    brand: 'Seating draw',
    branded: (event) => `${event} seating draw`,
    sub: '座位抽签',
    signOut: 'Sign out',
    lang: '切换到中文',
    loading: 'Loading',
    navDraw: 'The draw',
    navDoc: 'How it works',
    navLabel: 'Pages',
    adminPanel: 'Organiser panel',
  },
};

function Chrome({ lang, setLang, me, onSignOut, children, stage, view, setView, eventTitle }) {
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
          <span className="brand-name">{eventTitle ? t.branded(eventTitle) : t.brand}</span>
          {!eventTitle && <span className="en">{t.sub}</span>}
        </div>

        {/* Two destinations, not a tab bar over the draw: the left one is wherever the
            draw currently is, the right one is the explanation of it. */}
        <nav className="site-nav" aria-label={t.navLabel}>
          <button
            className={view === 'draw' ? 'nav-btn on' : 'nav-btn'}
            onClick={() => setView('draw')}
            aria-current={view === 'draw' ? 'page' : undefined}
          >
            {t.navDraw}
          </button>
          <button
            className={view === 'doc' ? 'nav-btn on' : 'nav-btn'}
            onClick={() => setView('doc')}
            aria-current={view === 'doc' ? 'page' : undefined}
          >
            {t.navDoc}
          </button>
        </nav>

        <div className="who">
          {me && <span className="who-name">{me.title}</span>}
          {/* Shown, not jumped to: an event admin is usually a player too, so the draw
              stays where it is and the dashboard opens beside it. Server-rendered and
              gated by the same session cookie, so a link is all the client does. */}
          {me?.is_admin && (
            <a className="linkish" href="/admin" target="_blank" rel="noopener">{t.adminPanel}</a>
          )}
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
      {/* One <main> that cross-fades between stages (UI-SPEC §1). */}
      <main key={view === 'doc' ? 'doc' : stage} className="stage-wrap">{children}</main>
    </>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [protocol, setProtocol] = useState(null);
  const [result, setResult] = useState(null);
  const [lang, setLangState] = useState(initialLang);
  const [view, setViewState] = useState('draw');

  const setLang = useCallback((next) => {
    setLangState(next);
    rememberLang(next);
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  }, []);
  useEffect(() => { document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'; }, [lang]);

  // The browser tab, for the same reason as the header: two of these open at once is
  // the ordinary case in a club that runs several events, and "座位抽签" twice over
  // tells a player nothing about which one they are about to submit into.
  const eventTitle = state.status?.event_title || null;
  useEffect(() => {
    const t = TEXT[lang] || TEXT.zh;
    document.title = eventTitle ? t.branded(eventTitle) : t.brand;
  }, [lang, eventTitle]);

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

  /** Switching views starts the new one at the top; a half-scrolled page is disorienting. */
  const setView = useCallback((next) => {
    setViewState(next);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  /**
   * Fetch the result once the draw is finished, whichever way the player arrived — and
   * again whenever the final round moves (PROTOCOL.md §11).
   *
   * The second half is not a refinement. `phase` is 'done' from the first draw onwards
   * and stays 'done' through the lock and through the twelfth round, which is what every
   * other part of this system needs it to do. So with `!result` as the only guard, a page
   * left open — or reopened weeks later from cache — held a result fetched before the
   * final round existed and would never ask again. The player would be told the draw was
   * complete while the round they were about to sit down for was missing from it.
   *
   * `final.state` plus the lock digest is the whole of what can change: 'none' to
   * 'locked' to 'drawn', and a --relock replaces the digest without moving the state.
   * Fetching is keyed to that pair rather than to a timer, so an idle page makes no
   * requests at all and a page watching the draw refetches exactly once per change.
   */
  const finalKey = state.status?.final
    ? `${state.status.final.state}:${state.status.final.lock_sha256 || ''}`
    : 'none';
  const fetchedFor = useRef(null);
  useEffect(() => {
    if (stage !== 'result' && stage !== 'revealing') return;
    if (result && fetchedFor.current === finalKey) return;
    // Claimed before the request rather than after it, so a re-render mid-flight does
    // not start a second one. Released on failure, so a request that never arrives is
    // retried rather than remembered as done.
    fetchedFor.current = finalKey;
    api.getResult().then(setResult).catch(() => { fetchedFor.current = null; });
  }, [stage, result, finalKey]);

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
  const backToDraw = useCallback(() => setView('draw'), [setView]);

  const body = useMemo(() => {
    if (view === 'doc') return <Doc onBack={backToDraw} />;
    switch (stage) {
      case 'loading':
        return <div className="stage centre"><div className="spinner" /></div>;
      case 'signin':
        return <SignIn status={state.status} onSignedIn={onSignedIn} />;
      case 'submit':
        return <Submit protocol={protocol} status={state.status} me={state.me} serverNow={serverNow} onSubmitted={onSubmitted} />;
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
  }, [view, backToDraw, stage, state, protocol, result, serverNow, onSignedIn, onSubmitted, onRevealDone]);

  return (
    <LangContext.Provider value={lang}>
      <Chrome
        lang={lang}
        setLang={setLang}
        me={state.me}
        onSignOut={onSignOut}
        stage={stage}
        view={view}
        setView={setView}
        eventTitle={eventTitle}
      >
        {body}
      </Chrome>
    </LangContext.Provider>
  );
}
