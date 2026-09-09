import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import * as api from './api';
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

export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [protocol, setProtocol] = useState(null);
  const [result, setResult] = useState(null);

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

  const body = useMemo(() => {
    switch (stage) {
      case 'loading':
        return <div className="stage centre"><div className="spinner" aria-label="Loading" /></div>;
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
    <>
      <header className="site">
        <div className="brand">座位抽签 <span className="en">Seating draw</span></div>
        {state.me && (
          <div className="who">
            {state.me.title}
            <button className="linkish" onClick={() => api.signOut().then(() => dispatch({ type: 'signedOut' }))}>
              退出
            </button>
          </div>
        )}
      </header>
      {/* One <main> that cross-fades between stages. No tab bar anywhere (UI-SPEC §1). */}
      <main key={stage} className="stage-wrap">{body}</main>
    </>
  );
}
