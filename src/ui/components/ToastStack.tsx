import { useUi } from '../../store';
import { IconButton } from './primitives';

/**
 * Transient messages.
 *
 * Deliberately *not* a live region. The `Announcer` already speaks, and
 * duplicating every toast into it produces the double-announcement that makes
 * screen reader users turn notifications off. Toasts here are the visual
 * channel; the store decides separately what is worth saying out loud.
 *
 * Anything with an action is given no timeout, because a message that can be
 * acted on must not vanish while the player is reaching for it.
 */
export function ToastStack() {
  const toasts = useUi((s) => s.toasts);
  const dismissToast = useUi((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="o-toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`o-toast o-toast--${toast.tone}`}>
          <div className="o-toast__text">
            <p className="o-toast__title">{toast.title}</p>
            {toast.detail ? <p className="o-toast__detail">{toast.detail}</p> : null}
            {toast.technical ? (
              // Muted and smaller: this is the server's own words, kept because
              // for a signalling failure it is the difference between "my
              // server is misconfigured" and "bad luck". It never leads.
              <p className="o-toast__technical">{toast.technical}</p>
            ) : null}
          </div>
          {toast.action ? (
            <button
              type="button"
              className="o-toast__action"
              onClick={() => {
                toast.action?.run();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <IconButton
            label={`Dismiss: ${toast.title}`}
            className="o-toast__close"
            onClick={() => dismissToast(toast.id)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="o-icon">
              <path d="M6 6 18 18M18 6 6 18" />
            </svg>
          </IconButton>
        </div>
      ))}
    </div>
  );
}
