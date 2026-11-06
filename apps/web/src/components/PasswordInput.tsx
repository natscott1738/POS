import { useState, type InputHTMLAttributes } from 'react';

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function PasswordInput({ className, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="password-input">
      <input {...props} className={['input', className].filter(Boolean).join(' ')} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="btn ghost password-input-toggle"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
