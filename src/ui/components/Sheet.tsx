import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

import { useFocusTrap } from '../lib/a11y';
import { IconButton } from './primitives';

/**
 * A modal panel. On a phone it is a bottom sheet -- the only part of the screen
 * a thumb can reach comfortably; on a wider screen it becomes a centred dialog.
 * Same component, one media query, no JS branch.
 *
 * What it takes care of so callers do not have to:
 *  - `role="dialog"` + `aria-modal` + a labelled heading
 *  - focus moved in on open and restored on close
 *  - Tab cycling kept inside
 *  - Escape and backdrop-tap to dismiss
 *  - `inert`-style hiding of the rest of the app from assistive tech, so a
 *    screen reader cannot wander onto the 3D canvas behind the sheet
 *  - background scroll lock, which on iOS is the difference between a sheet and
 *    a sheet that drags the board around underneath it
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  /** Give the sheet its natural height instead of stretching. */
  compact = false,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = labelledBy ?? 'sheet-title';
  const descId = description ? 'sheet-desc' : undefined;

  useFocusTrap(panelRef, { active: open, onEscape: onClose });

  useEffect(() => {
    if (!open) return;
    const root = document.getElementById('root');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Hide the app behind the sheet from assistive technology. Without this a
    // screen reader happily reads the board and the HUD "through" the modal.
    root?.setAttribute('aria-hidden', 'true');
    return () => {
      document.body.style.overflow = previousOverflow;
      root?.removeAttribute('aria-hidden');
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <>
      {/*
        The backdrop is a plain div with a pointer handler rather than a button:
        it is a redundant affordance (Escape and the close button both work) and
        making it focusable would put a nameless control in the tab order.
        `.app-scrim` and `.app-sheet` come from layout.css, which already turns
        the same markup into a bottom sheet on a phone and a centred dialog from
        768px up.
      */}
      <div className="app-scrim" onPointerDown={onClose} aria-hidden="true" />
      <div
        className={['app-sheet o-sheet', compact ? 'o-sheet--compact' : ''].filter(Boolean).join(' ')}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descId}
        tabIndex={-1}
      >
        <div className="o-sheet__grip" aria-hidden="true" />
        <header className="o-sheet__header">
          <h2 className="o-sheet__title" id={headingId}>
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose} className="o-sheet__close">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="o-icon">
              <path d="M6 6 18 18M18 6 6 18" />
            </svg>
          </IconButton>
        </header>
        {description ? (
          <p className="o-sheet__desc" id={descId}>
            {description}
          </p>
        ) : null}
        <div className="o-sheet__body">{children}</div>
        {footer ? <footer className="o-sheet__footer">{footer}</footer> : null}
      </div>
    </>,
    document.body,
  );
}
