import { useState } from 'react';
import * as api from '../api';
import { useText } from '../i18n';

/**
 * Sign-in (UI-SPEC.md §3).
 *
 * The browser authenticates against Pantheon directly and posts only the returned
 * token pair; this app never handles a Pantheon password (PANTHEON-INTEGRATION.md §2).
 *
 * The failure messages must stay distinct and non-confusable. "Not registered for this
 * event" is a normal outcome, not an error state, and is styled as information — a
 * player who is simply not in the twelve should not be made to feel something broke.
 * Which failure it was is decided by signInProblem() in api.js, not here, so the one
 * rule that matters — nothing reads as a wrong password unless Frey or this server's
 * re-check refused the credentials — is a tested property rather than a default branch.
 *
 * Stub mode swaps the fields and nothing else. It is the same card, the same shell and
 * the same rhythm, because it is the page a player will meet in production and the only
 * honest way to look at it in development is for it to be the same page.
 */

const TEXT = {
  zh: {
    title: '座位抽签',
    branded: (event) => `${event}座位抽签`,
    lede: '用你的 Pantheon 账号登录，参加本次座位抽签。',
    show: '显示密码',
    hide: '隐藏密码',
    devMode: '开发模式',
    devHint: '本机没有可连的 Pantheon 实例，所以走的是开发替代路径；正式部署时这里是邮箱和密码。',
    email: '邮箱',
    password: '密码',
    pidPlaceholder: 'Pantheon person_id，例如 1001',
    signIn: '登录',
    signingIn: '登录中…',
    rejected: 'Pantheon 不认识这个邮箱和密码。',
    unknownAccount: 'Pantheon 里没有这个邮箱的账号。确认一下是不是用另一个邮箱注册的。',
    unreachable: '连不上 Pantheon，所以没能验证你的身份。这不是你的问题，请联系组织者。',
    misconfigured: '这次抽签的 Pantheon 地址配置有误，登录无法进行。请把下面这行发给组织者。',
    pantheonError: 'Pantheon 出错了，暂时无法登录。稍后再试，或联系组织者。',
    notRegistered: '这个账号没有报名本次活动，无法参加抽签。',
    pantheonUnavailable: '抽签服务器现在连不上 Pantheon，所以没能验证你的身份。稍后再试。',
    rateLimited: '登录尝试太频繁，请等一分钟再试。',
    plainHttp: '这个页面是用 http 打开的，登录状态保存不下来。请用 https:// 重新打开。',
    sessionNotKept: '登录成功，但浏览器没有保存会话。请检查是否禁用了 cookie，或者换一个浏览器。',
    relayUnreachable: '连不上抽签服务器（不是 Pantheon）。这不是你的问题，请联系组织者。',
    relayError: '抽签服务器出错了。请把下面这行发给组织者。',
    unexpected: '登录失败，原因这个页面认不出来。请把下面这行发给组织者。',
    fineprint: '你的密码只发给 Pantheon，不会经过这个应用。',
  },
  en: {
    title: 'Seating draw',
    branded: (event) => `${event} seating draw`,
    lede: 'Sign in with your Pantheon account to take part in the draw.',
    show: 'Show password',
    hide: 'Hide password',
    devMode: 'dev mode',
    devHint: 'No Pantheon instance is reachable here, so this is the development stand-in. A real deployment asks for an email and password.',
    email: 'Email',
    password: 'Password',
    pidPlaceholder: 'Pantheon person_id, e.g. 1001',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    rejected: 'Pantheon did not recognise that email and password.',
    unknownAccount: 'Pantheon has no account with that email address. Check whether you registered under a different one.',
    unreachable: 'Pantheon could not be reached, so your sign-in could not be checked. This is not something you did; please tell the organiser.',
    misconfigured: 'This draw is pointed at the wrong Pantheon address, so sign-in cannot work. Please send the line below to the organiser.',
    pantheonError: 'Pantheon returned an error, so sign-in is unavailable right now. Try again shortly, or tell the organiser.',
    notRegistered: "That account isn't registered for this event, so it can't take part in the draw.",
    pantheonUnavailable: 'The draw server cannot reach Pantheon right now, so your sign-in could not be checked. Try again shortly.',
    rateLimited: 'Too many sign-in attempts from this address. Wait a minute and try again.',
    plainHttp: 'This page was opened over http, so the sign-in cannot be kept. Open it again at https://.',
    sessionNotKept: 'Pantheon accepted the sign-in, but this browser did not keep the session. Check whether cookies are blocked, or try another browser.',
    relayUnreachable: 'The draw server could not be reached — this one, not Pantheon. This is not something you did; please tell the organiser.',
    relayError: 'The draw server returned an error. Please send the line below to the organiser.',
    unexpected: 'Sign-in failed for a reason this page does not recognise. Please send the line below to the organiser.',
    fineprint: 'Your password goes to Pantheon only. It never passes through this app.',
  },
};

/**
 * The field labels, as icons inside the box (UI-SPEC §3). An envelope and a padlock are
 * the two most over-learned glyphs on the web; a word above each box said nothing they
 * do not, and cost two lines of the card's height.
 *
 * Decorative in the accessibility tree — the word itself is on an .sr-only <label>, so
 * the field is still announced, and stroke and colour come from .field-icon.
 */
function MailIcon() {
  return (
    <svg className="field-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M3.8 7.7 12 12.9l8.2-5.2" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="field-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="10.4" width="15" height="9.6" rx="2.4" />
      <path d="M8.25 10.4V7.6a3.75 3.75 0 0 1 7.5 0v2.8" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg className="field-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8.4" r="3.4" />
      <path d="M4.9 19.6a7.2 7.2 0 0 1 14.2 0" />
    </svg>
  );
}

/** An eye, struck through while the password is visible: the icon shows what tapping
 *  it will do next, which is the convention every password field on a phone uses. */
function Eye({ off }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" className="eye">
      <path d="M1.6 12S5.6 5.5 12 5.5 22.4 12 22.4 12 18.4 18.5 12 18.5 1.6 12 1.6 12Z" />
      <circle cx="12" cy="12" r="3.1" />
      {off && <path d="M4 20 20 4" className="eye-slash" />}
    </svg>
  );
}

export default function SignIn({ status, onSignedIn }) {
  const t = useText(TEXT);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [personId, setPersonId] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null); // {kind: 'error'|'info', text}
  // Off by default, because a shoulder is a likelier threat than a typo on a phone in a
  // clubhouse. On by one tap, because the alternative is a player mistyping a password
  // three times and concluding Pantheon has forgotten them.
  const [showPassword, setShowPassword] = useState(false);

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
      await api.createSession(pair.person_id, pair.auth_token);
      // A 200 from POST /api/session says the server issued a cookie. It does not say
      // the browser kept it, and over plain http in production it will not: the cookie
      // is marked Secure, the page moved on, and the first failure was the submission,
      // after the player had sealed a number. So the session is read back before the
      // page moves, and a 401 here is reported as what it is.
      let me;
      try {
        me = await api.getMe();
      } catch (e) {
        if (e.status !== 401) throw e;
        const err = new Error('signed in, but the browser did not keep the session cookie');
        err.code = 'session_not_kept';
        err.detail = 'POST /api/session → 200, then GET /api/me → 401';
        throw err;
      }
      onSignedIn(me);
    } catch (err) {
      // §3 requires the failures to stay distinguishable. The old `default` here said
      // "wrong password" for anything it did not name, and on the first production
      // deployment that covered a server that was down, a shared rate limit and a 500.
      // Anything the player cannot act on carries the technical line as well, so
      // whoever they forward it to sees what actually happened.
      const p = api.signInProblem(err);
      const text = {
        not_registered: t.notRegistered,
        pantheon_unavailable: t.pantheonUnavailable, // this server could not reach Pantheon
        bad_credentials: t.rejected,
        unknown_account: t.unknownAccount,
        pantheon_unreachable: t.unreachable,         // the browser could not reach Frey
        pantheon_misconfigured: t.misconfigured,
        pantheon_error: t.pantheonError,
        rate_limited: t.rateLimited,
        plain_http: t.plainHttp,
        session_not_kept: t.sessionNotKept,
        relay_unreachable: t.relayUnreachable,       // the browser could not reach THIS server
        relay_error: t.relayError,
        unexpected: t.unexpected,
      }[p.kind];
      // The refusals a player can act on alone carry no technical line: a status code
      // under "wrong password" reads as blame.
      const quiet = p.kind === 'bad_credentials' || p.kind === 'unknown_account' || p.kind === 'not_registered';
      setProblem({ kind: p.kind === 'not_registered' ? 'info' : 'error', text, detail: quiet ? null : p.detail });
      setBusy(false);
    }
  }

  return (
    <div className="stage centre">
      <form className="card signin" onSubmit={onSubmit}>
        <h1>{status?.event_title ? t.branded(status.event_title) : t.title}</h1>
        <p className="lede">{t.lede}</p>

        {stub ? (
          <>
            <label className="sr-only" htmlFor="pid">Pantheon person_id</label>
            <div className="field">
              <PersonIcon />
              <input id="pid" inputMode="numeric" autoComplete="off" value={personId}
                     onChange={(e) => setPersonId(e.target.value)}
                     placeholder={t.pidPlaceholder} required />
            </div>
            <p className="hint"><span className="devnote">{t.devMode}</span>{t.devHint}</p>
          </>
        ) : (
          <>
            <label className="sr-only" htmlFor="email">{t.email}</label>
            <div className="field">
              <MailIcon />
              <input id="email" type="email" autoComplete="username" value={email}
                     onChange={(e) => setEmail(e.target.value)}
                     placeholder={t.email} required />
            </div>

            <label className="sr-only" htmlFor="pw">{t.password}</label>
            <div className="field pw">
              <LockIcon />
              <input id="pw" type={showPassword ? 'text' : 'password'}
                     autoComplete="current-password" value={password}
                     onChange={(e) => setPassword(e.target.value)}
                     placeholder={t.password} required />
              <button
                type="button"
                className="pw-reveal"
                onClick={() => setShowPassword((v) => !v)}
                aria-pressed={showPassword}
                aria-label={showPassword ? t.hide : t.show}
                title={showPassword ? t.hide : t.show}
              >
                <Eye off={showPassword} />
              </button>
            </div>
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
