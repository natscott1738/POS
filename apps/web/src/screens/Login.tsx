import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { useAuth, toast, type SessionUser } from '../lib/store.js';
import { getMeta, setMeta } from '../lib/db.js';

interface AuthResponse {
  accessToken: string;
  csrfToken: string;
  user: SessionUser;
}

export default function Login() {
  const [mode, setMode] = useState<'pin' | 'password' | 'forgot'>('pin');
  const [terminalId, setTerminalId] = useState('');
  const signIn = useAuth((s) => s.signIn);

  useEffect(() => {
    void getMeta<string | null>('terminalId', null).then((value) => {
      if (value) setTerminalId(value);
      else setMode('password');
    });
  }, []);

  return (
    <div className="login-shell">
      <div className="login-card card">
        <h1 style={{ marginTop: 0, fontSize: 22 }}>Backyard POS</h1>
        <div className="tabs">
          <button className={mode === 'pin' ? 'active' : ''} onClick={() => setMode('pin')}>
            Till PIN
          </button>
          <button className={mode === 'password' ? 'active' : ''} onClick={() => setMode('password')}>
            Email
          </button>
        </div>
        {mode === 'pin' && <PinForm terminalId={terminalId} setTerminalId={setTerminalId} onSuccess={signIn} />}
        {mode === 'password' && <PasswordForm onSuccess={signIn} onForgot={() => setMode('forgot')} />}
        {mode === 'forgot' && <ForgotPassword onBack={() => setMode('password')} />}
      </div>
    </div>
  );
}

function PinForm({
  terminalId,
  setTerminalId,
  onSuccess,
}: {
  terminalId: string;
  setTerminalId: (v: string) => void;
  onSuccess: (payload: AuthResponse, terminalId?: string) => Promise<void>;
}) {
  const [staffCode, setStaffCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  void setTerminalId;

  async function submit(): Promise<void> {
    if (!terminalId || !staffCode || pin.length < 4) return;
    setBusy(true);
    try {
      await setMeta('terminalId', terminalId);
      const response = await api.post<AuthResponse>('/auth/pin-login', {
        terminalId,
        staffCode: staffCode.toUpperCase(),
        pin,
      });
      await onSuccess(response, terminalId);
    } catch (err) {
      setPin('');
      toast.error(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!terminalId && (
        <div className="banner warning">
          This device is not set up yet. Sign in with an email address once and
          choose the till; after that, staff can sign in here with a PIN.
        </div>
      )}
      <div className="field">
        <label className="label" htmlFor="staff">Staff code</label>
        <input
          id="staff"
          className="input"
          value={staffCode}
          onChange={(e) => setStaffCode(e.target.value.toUpperCase())}
          placeholder="CSH001"
          autoComplete="off"
          autoCapitalize="characters"
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="pin">PIN</label>
        <input
          id="pin"
          className="input mono"
          type="password"
          value={pin}
          readOnly
          inputMode="none"
          placeholder="••••"
          style={{ letterSpacing: 8, fontSize: 20, textAlign: 'center' }}
        />
      </div>
      <div className="keypad" style={{ marginBottom: 14 }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button key={digit} onClick={() => setPin((p) => (p.length < 8 ? p + digit : p))}>
            {digit}
          </button>
        ))}
        <button onClick={() => setPin('')}>C</button>
        <button onClick={() => setPin((p) => (p.length < 8 ? p + '0' : p))}>0</button>
        <button onClick={() => setPin((p) => p.slice(0, -1))}>←</button>
      </div>
      <button className="btn primary block lg" disabled={busy || pin.length < 4} onClick={() => void submit()}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </>
  );
}

function PasswordForm({
  onSuccess,
  onForgot,
}: {
  onSuccess: (payload: AuthResponse) => Promise<void>;
  onForgot: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await api.post<AuthResponse>('/auth/login', {
        email,
        password,
        ...(totp ? { totp } : {}),
      });
      await onSuccess(response);
      if (response.user.mustChangePassword) {
        toast.warning('You must change your password before continuing.');
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') {
        setNeedsMfa(true);
        toast.info('Enter the code from your authenticator app.');
      } else {
        setPassword('');
        toast.error(err instanceof ApiError ? err.message : 'Sign-in failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label className="label" htmlFor="email">Email</label>
        <input
          id="email"
          className="input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="password">Password</label>
        <input
          id="password"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>
      {needsMfa && (
        <div className="field">
          <label className="label" htmlFor="totp">Authentication code</label>
          <input
            id="totp"
            className="input mono"
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
          />
        </div>
      )}
      <button className="btn primary block lg" type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <button
        type="button"
        className="btn ghost block"
        style={{ marginTop: 8 }}
        onClick={onForgot}
      >
        Forgotten your password?
      </button>
    </form>
  );
}

/**
 * Password reset request. The response is identical whether or not the address
 * exists, so this screen can never be used to discover which staff emails are real.
 */
function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function request(): Promise<void> {
    setBusy(true);
    try {
      // The code arrives by email only; the API never returns it to this screen.
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  async function complete(): Promise<void> {
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token: resetToken, newPassword });
      toast.success('Password updated. Please sign in.');
      onBack();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  if (!sent) {
    return (
      <>
        <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
          Enter your email address and we will issue a reset.
        </p>
        <div className="field">
          <label className="label" htmlFor="forgot-email">Email</label>
          <input id="forgot-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <button className="btn primary block lg" disabled={busy || !email} onClick={() => void request()}>
          {busy ? 'Working…' : 'Request reset'}
        </button>
        <button className="btn ghost block" style={{ marginTop: 8 }} onClick={onBack}>Back</button>
      </>
    );
  }

  return (
    <>
      <div className="banner warning">
        If that address belongs to an active account, a reset has been issued. It expires in 30 minutes.
      </div>
      <div className="field">
        <label className="label" htmlFor="reset-code">Reset code</label>
        <input id="reset-code" className="input mono" value={resetToken} onChange={(e) => setResetToken(e.target.value.trim())} autoFocus />
      </div>
      <div className="field">
        <label className="label" htmlFor="new-password">New password</label>
        <input
          id="new-password"
          className="input"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
        />
        <span className="muted" style={{ fontSize: 12 }}>At least 12 characters.</span>
      </div>
      <button
        className="btn primary block lg"
        disabled={busy || newPassword.length < 12 || !resetToken}
        onClick={() => void complete()}
      >
        {busy ? 'Saving…' : 'Set new password'}
      </button>
      <button className="btn ghost block" style={{ marginTop: 8 }} onClick={onBack}>Back to sign in</button>
    </>
  );
}
