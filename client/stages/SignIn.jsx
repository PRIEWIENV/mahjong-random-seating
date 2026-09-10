import { useState } from 'react';
import * as api from '../api';
import { useText } from '../i18n';

/**
 * Sign-in (UI-SPEC.md §3).
 *
 * The browser authenticates against Pantheon directly and posts only the returned
 * token pair; this app never handles a Pantheon password (PANTHEON-INTEGRATION.md §2).
 *
 * The two failure messages must stay distinct and non-confusable. "Not registered for
 * this event" is a normal outcome, not an error state, and is styled as information —
 * a player who is simply not in the twelve should not be made to feel something broke.
 */

const TEXT = {
  zh: {
    title: '座位抽签',
    lede: '用你的 Pantheon 账号登录，参加本次座位抽签。',
    devMode: '开发模式',
    devHint: '本机没有可连的 Pantheon 实例，所以走的是开发替代路径；正式部署时这里是邮箱和密码。',
    email: '邮箱',
    password: '密码',
    signIn: '登录',
    signingIn: '登录中…',
    rejected: 'Pantheon 不认识这个邮箱和密码。',
    fineprint: '你的密码只发给 Pantheon，不会经过这个应用。',
  },
  en: {
    title: 'Seating draw',
    lede: 'Sign in with your Pantheon account to take part in the draw.',
    devMode: 'dev mode',
    devHint: 'No Pantheon instance is reachable here, so this is the development stand-in. A real deployment asks for an email and password.',
    email: 'Email',
    password: 'Password',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    rejected: 'Pantheon did not recognise that email and password.',
    fineprint: 'Your password goes to Pantheon only. It never passes through this app.',
  },
};

export default function SignIn({ status, onSignedIn }) {
  const t = useText(TEXT);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [personId, setPersonId] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null); // {kind: 'error'|'info', text}

  const stub = status?.auth_mode === 'stub';

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const pair = await api.authorize({
        email, password, personId,
        authMode: status?.auth_mode,
        freyBaseUrl: status?.frey_base_url,
        freyAuthorizePath: status?.frey_authorize_path,
      });
      const me = await api.createSession(pair.person_id, pair.auth_token);
      onSignedIn(me);
    } catch (err) {
      // The server's own wording for these two: they are the ones §3 requires to stay
      // distinguishable, and it knows which case it is.
      if (err.code === 'not_registered') {
        setProblem({ kind: 'info', text: err.message });
      } else if (err.code === 'pantheon_unavailable') {
        setProblem({ kind: 'error', text: err.message });
      } else {
        setProblem({ kind: 'error', text: t.rejected });
      }
      setBusy(false);
    }
  }

  return (
    <div className="stage centre">
      <form className="card signin" onSubmit={onSubmit}>
        <h1>{t.title}</h1>
        <p className="lede">{t.lede}</p>

        {stub ? (
          <>
            <label htmlFor="pid">Pantheon person_id<span className="devnote">{t.devMode}</span></label>
            <input id="pid" inputMode="numeric" autoComplete="off" value={personId}
                   onChange={(e) => setPersonId(e.target.value)} placeholder="1001" required />
            <p className="hint">{t.devHint}</p>
          </>
        ) : (
          <>
            <label htmlFor="email">{t.email}</label>
            <input id="email" type="email" autoComplete="username" value={email}
                   onChange={(e) => setEmail(e.target.value)} required />
            <label htmlFor="pw">{t.password}</label>
            <input id="pw" type="password" autoComplete="current-password" value={password}
                   onChange={(e) => setPassword(e.target.value)} required />
          </>
        )}

        <button type="submit" disabled={busy}>{busy ? t.signingIn : t.signIn}</button>
        {problem && <p className={problem.kind === 'info' ? 'note info' : 'note bad'}>{problem.text}</p>}
        <p className="fineprint">{t.fineprint}</p>
      </form>
    </div>
  );
}
