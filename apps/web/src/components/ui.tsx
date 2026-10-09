import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 18, alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
          {subtitle && <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>{subtitle}</p>}
        </div>
        <div className="spacer" />
        {actions}
      </div>
      {children}
    </div>
  );
}

/**
 * Labelled form field.
 *
 * The label is wired to its control with a generated id, so screen readers
 * announce it and every input is reachable by its visible name. Doing it here
 * means no form in the app can forget it.
 */
export function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const generatedId = useId();
  const hintId = `${generatedId}-hint`;

  // Attach the id to the first control inside, unless it already carries one.
  // Note: identity comparison against Children.toArray() output does not work —
  // it clones elements to add keys — so the first valid element is claimed by
  // position instead.
  let claimed = false;
  let controlId = generatedId;

  const labelled = Children.map(children, (child) => {
    if (claimed || !isValidElement(child)) return child;
    claimed = true;
    const element = child as ReactElement<Record<string, unknown>>;
    const existing = element.props?.id as string | undefined;
    controlId = existing ?? generatedId;
    return cloneElement(element, {
      id: controlId,
      ...(hint ? { 'aria-describedby': hintId } : {}),
    });
  });

  return (
    <div className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <label className="label" htmlFor={controlId}>{label}</label>
      {labelled}
      {hint && <span className="muted" id={hintId} style={{ fontSize: 12 }}>{hint}</span>}
    </div>
  );
}

export function FormGrid({ children, columns = 2 }: { children: ReactNode; columns?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: '0 14px' }}>
      {children}
    </div>
  );
}

export function Empty({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div style={{ padding: '36px 20px', textAlign: 'center' }}>
      <p className="muted" style={{ margin: 0 }}>{message}</p>
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function Loading() {
  return <p className="muted" style={{ padding: 20 }}>Loading…</p>;
}

/**
 * Money input that keeps the caller in integer cents.
 *
 * Spreads unknown props onto the underlying input so `Field` can attach the id
 * that links it to its label — without that, the label points at nothing and the
 * control is unreachable by name for both screen readers and tests.
 */
export function MoneyInput({
  value,
  onChange,
  autoFocus,
  placeholder,
  ...rest
}: {
  value: number;
  onChange: (cents: number) => void;
  autoFocus?: boolean;
  placeholder?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input
      {...rest}
      className="input mono"
      inputMode="decimal"
      autoFocus={autoFocus}
      placeholder={placeholder}
      value={value === 0 ? '' : (value / 100).toFixed(2)}
      onChange={(e) => {
        const cleaned = e.target.value.replace(/[^\d.]/g, '');
        const parsed = Number(cleaned);
        onChange(Number.isFinite(parsed) ? Math.round(parsed * 100) : 0);
      }}
    />
  );
}

/** Quantity input; the model is thousandths of a unit throughout. */
export function QuantityInput({
  value,
  onChange,
  autoFocus,
  ...rest
}: {
  value: number;
  onChange: (milli: number) => void;
  autoFocus?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input
      {...rest}
      className="input mono"
      inputMode="decimal"
      autoFocus={autoFocus}
      value={value === 0 ? '' : String(value / 1000)}
      onChange={(e) => {
        const cleaned = e.target.value.replace(/[^\d.-]/g, '');
        const parsed = Number(cleaned);
        onChange(Number.isFinite(parsed) ? Math.round(parsed * 1000) : 0);
      }}
    />
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'success' | 'warning' | 'danger' }) {
  const colour =
    tone === 'success' ? 'var(--success)' : tone === 'warning' ? 'var(--warning)' : tone === 'danger' ? 'var(--danger)' : undefined;
  return <span className="pill" style={colour ? { color: colour } : undefined}>{children}</span>;
}
