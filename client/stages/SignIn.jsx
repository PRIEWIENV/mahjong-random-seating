import { useState } from 'react';
import * as api from '../api';

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
export default function SignIn({ status, onSignedIn }) {
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
      });
      const me = await api.createSession(pair.person_id, pair.auth_token);
      onSignedIn(me);
    } catch (err) {
      if (err.code === 'not_registered') {
        setProblem({ kind: 'info', text: err.message });
      } else if (err.code === 'pantheon_unavailable') {
        setProblem({ kind: 'error', text: err.message });
      } else {
        setProblem({ kind: 'error', text: 'Pantheon did not recognise that email and password.' });
      }
      setBusy(false);
    }
  }

  return (
    <div className="stage centre">
      <form className="card signin" onSubmit={onSubmit}>
        <h1>座位抽签</h1>
        <p className="lede">用你的 Pantheon 账号登录，参加本次座位抽签。</p>

        {stub ? (
          <>
            <label htmlFor="pid">Pantheon person_id<span className="devnote">开发模式</span></label>
            <input id="pid" inputMode="numeric" autoComplete="off" value={personId}
                   onChange={(e) => setPersonId(e.target.value)} placeholder="1001" required />
            <p className="hint">
              本机没有可连的 Pantheon 实例，所以走的是开发替代路径；正式部署时这里是邮箱和密码。
            </p>
          </>
        ) : (
          <>
            <label htmlFor="email">邮箱</label>
            <input id="email" type="email" autoComplete="username" value={email}
                   onChange={(e) => setEmail(e.target.value)} required />
            <label htmlFor="pw">密码</label>
            <input id="pw" type="password" autoComplete="current-password" value={password}
                   onChange={(e) => setPassword(e.target.value)} required />
          </>
        )}

        <button type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
        {problem && <p className={problem.kind === 'info' ? 'note info' : 'note bad'}>{problem.text}</p>}
        <p className="fineprint">你的密码只发给 Pantheon，不会经过这个应用。</p>
      </form>
    </div>
  );
}
