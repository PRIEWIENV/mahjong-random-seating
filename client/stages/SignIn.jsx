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
    unknownAccount: 'Pantheon 里没有这个邮箱的账号。确认一下是不是用另一个邮箱注册的。',
    unreachable: '连不上 Pantheon，所以没能验证你的身份。这不是你的问题，请联系组织者。',
    misconfigured: '这次抽签的 Pantheon 地址配置有误，登录无法进行。请把下面这行发给组织者。',
    pantheonError: 'Pantheon 出错了，暂时无法登录。稍后再试，或联系组织者。',
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
    unknownAccount: 'Pantheon has no account with that email address. Check whether you registered under a different one.',
    unreachable: 'Pantheon could not be reached, so your sign-in could not be checked. This is not something you did; please tell the organiser.',
    misconfigured: 'This draw is pointed at the wrong Pantheon address, so sign-in cannot work. Please send the line below to the organiser.',
    pantheonError: 'Pantheon returned an error, so sign-in is unavailable right now. Try again shortly, or tell the organiser.',
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
      // §3 requires the failures to stay distinguishable, and the old `else` swallowed
      // every one of them into "wrong password" — including an unreachable Frey and a
      // mistyped base URL, which sent more than one deployment looking at the wrong
      // thing. Anything the player cannot act on carries the technical line as well, so
      // whoever they forward it to sees what actually happened.
      const detail = err.detail || null;
      switch (err.code) {
        case 'not_registered':
          setProblem({ kind: 'info', text: err.message });
          break;
        case 'pantheon_unavailable':          // our server could not reach Pantheon
          setProblem({ kind: 'error', text: err.message, detail });
          break;
        case 'pantheon_unreachable':          // the browser could not reach Frey
          setProblem({ kind: 'error', text: t.unreachable, detail: detail || err.message });
          break;
        case 'pantheon_misconfigured':
          setProblem({ kind: 'error', text: t.misconfigured, detail: detail || err.message });
          break;
        case 'pantheon_error':
          setProblem({ kind: 'error', text: t.pantheonError, detail });
          break;
        case 'unknown_account':
          setProblem({ kind: 'error', text: t.unknownAccount });
          break;
        default:
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
        {problem && (
          <p className={problem.kind === 'info' ? 'note info' : 'note bad'}>
            {problem.text}
            {problem.detail && <code className="detail">{problem.detail}</code>}
          </p>
        )}
        <p className="fineprint">{t.fineprint}</p>
      </form>
    </div>
  );
}
