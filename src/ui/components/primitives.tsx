import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/**
 * The small set of controls everything else is built from.
 *
 * Two rules run through all of them:
 *
 *  1. **Everything is a real control.** Buttons are `<button>`, toggles are
 *     `<input type="checkbox" role="switch">`, fields have real `<label>`s. No
 *     `<div onClick>`. This is most of what makes the app keyboard-operable
 *     without any extra work.
 *  2. **Touch targets are at least 44px.** Not "usually" -- the minimum is
 *     enforced in CSS on `.o-btn` itself so a variant cannot quietly opt out.
 *     Four people passing phones around a table are not aiming carefully.
 */

/* -------------------------------------------------------------------------- *
 * Visually hidden
 * -------------------------------------------------------------------------- */

/**
 * Hidden from sight, present for screen readers.
 *
 * `focusable` keeps it hidden until something inside takes focus, at which
 * point it becomes visible -- the skip-link pattern. Used for the text board,
 * so a sighted keyboard user can see where their focus went.
 */
export function VisuallyHidden({
  children,
  focusable = false,
  as: Tag = 'span',
}: {
  children: ReactNode;
  focusable?: boolean;
  as?: 'span' | 'div';
}) {
  return <Tag className={focusable ? 'u-visually-hidden-focusable' : 'u-visually-hidden'}>{children}</Tag>;
}

/* -------------------------------------------------------------------------- *
 * Button
 * -------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container. The default on phones for anything important. */
  block?: boolean;
  /** Shows a spinner and blocks input without changing the layout. */
  busy?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block, busy, icon, children, className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      // Disabled buttons are unreachable by keyboard and invisible to some
      // screen readers, so a *busy* button stays enabled and announces itself
      // instead. A genuinely unavailable action still uses `disabled`.
      disabled={disabled}
      aria-busy={busy || undefined}
      className={[
        'o-btn',
        `o-btn--${variant}`,
        `o-btn--${size}`,
        block ? 'o-btn--block' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      <span className="o-btn__label">{children}</span>
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only button with no accessible name is a dead end. */
  label: string;
  children: ReactNode;
  variant?: ButtonVariant;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, variant = 'ghost', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={['o-iconbtn', `o-btn--${variant}`, className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
});

/* -------------------------------------------------------------------------- *
 * Spinner
 * -------------------------------------------------------------------------- */

/**
 * `aria-hidden` on purpose: the surrounding control carries `aria-busy`, and a
 * spinner that announces itself just adds noise to every pending action.
 */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="o-spinner" aria-hidden="true" data-label={label}>
      <span className="o-spinner__dot" />
      <span className="o-spinner__dot" />
      <span className="o-spinner__dot" />
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 * Field
 * -------------------------------------------------------------------------- */

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Persistent helper text. Always rendered, so the layout never jumps. */
  hint?: string;
  /** Turns the field into an error state and links the message to it. */
  error?: string | null;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, id, className, ...rest },
  ref,
) {
  const inputId = id ?? `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className={['o-field', error ? 'o-field--error' : '', className ?? ''].filter(Boolean).join(' ')}>
      <label className="o-field__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        className="o-field__input"
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {hint ? (
        <p className="o-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        // `role="alert"` so a validation failure is spoken the moment it
        // appears, rather than waiting for the player to tab back.
        <p className="o-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
});

/* -------------------------------------------------------------------------- *
 * Switch
 * -------------------------------------------------------------------------- */

export function Switch({
  label,
  description,
  checked,
  onChange,
  id,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  id?: string;
}) {
  const inputId = id ?? `sw-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const descId = description ? `${inputId}-desc` : undefined;
  return (
    <div className="o-switch">
      <div className="o-switch__text">
        <label className="o-switch__label" htmlFor={inputId}>
          {label}
        </label>
        {description ? (
          <p className="o-switch__desc" id={descId}>
            {description}
          </p>
        ) : null}
      </div>
      <input
        id={inputId}
        className="o-switch__input"
        type="checkbox"
        role="switch"
        checked={checked}
        aria-describedby={descId}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="o-switch__track" aria-hidden="true">
        <span className="o-switch__thumb" />
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Segmented control
 * -------------------------------------------------------------------------- */

/**
 * A small set of mutually exclusive options -- player count, theme.
 *
 * Built from real radios inside a `<fieldset>` so arrow keys work, the group
 * has a name, and the current choice is announced. A row of buttons with
 * `aria-pressed` would look identical and behave worse.
 */
export function Segmented<T extends string | number>({
  legend,
  options,
  value,
  onChange,
  name,
  hint,
}: {
  legend: string;
  options: Array<{ value: T; label: string; detail?: string; disabled?: boolean }>;
  value: T;
  onChange: (next: T) => void;
  name: string;
  hint?: string;
}) {
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <fieldset className="o-seg" aria-describedby={hintId}>
      <legend className="o-seg__legend">{legend}</legend>
      <div className="o-seg__options">
        {options.map((opt) => (
          <label
            key={String(opt.value)}
            className={[
              'o-seg__option',
              value === opt.value ? 'is-selected' : '',
              opt.disabled ? 'is-disabled' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <input
              className="u-visually-hidden"
              type="radio"
              name={name}
              value={String(opt.value)}
              checked={value === opt.value}
              disabled={opt.disabled}
              onChange={() => onChange(opt.value)}
            />
            <span className="o-seg__optionLabel">{opt.label}</span>
            {opt.detail ? <span className="o-seg__optionDetail">{opt.detail}</span> : null}
          </label>
        ))}
      </div>
      {hint ? (
        <p className="o-seg__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- *
 * Pill
 * -------------------------------------------------------------------------- */

export function Pill({
  tone = 'neutral',
  children,
  icon,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'busy' | 'accent';
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <span className={`o-pill o-pill--${tone}`}>
      {icon}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 * Card
 * -------------------------------------------------------------------------- */

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'li';
}) {
  return <Tag className={['o-card', className ?? ''].filter(Boolean).join(' ')}>{children}</Tag>;
}
