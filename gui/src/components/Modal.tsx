import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

export function Modal({
  children,
  onClose,
  labelledBy,
  ariaLabel,
  closeOnEscape = true,
}: {
  children: ReactNode;
  onClose?: () => void;
  labelledBy?: string;
  ariaLabel?: string;
  closeOnEscape?: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!overlay.contains(document.activeElement)) {
      const first = focusableElements(overlay)[0];
      (first || overlay).focus();
    }
    return () => {
      const previous = restoreFocusRef.current;
      if (previous?.isConnected) {
        try {
          previous.focus();
        } catch {
          /* element may no longer accept focus */
        }
      }
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && closeOnEscape && onClose) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const items = focusableElements(overlay);
    if (items.length === 0) {
      event.preventDefault();
      overlay.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!overlay.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={overlayRef}
      className="key-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
