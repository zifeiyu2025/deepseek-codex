import { useEffect } from 'react';

type MenuBinding = {
  isOpen: boolean;
  selector: string;
  close: () => void;
};

export function useDismissOnOutside(bindings: MenuBinding[]) {
  const signature = bindings
    .map((binding) => `${binding.isOpen ? '1' : '0'}:${binding.selector}`)
    .join('|');

  useEffect(() => {
    const active = bindings.filter((binding) => binding.isOpen);
    if (active.length === 0) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      for (const binding of active) {
        if (!target?.closest(binding.selector)) binding.close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      for (const binding of active) binding.close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
    // The signature captures open state and containers; close callbacks only
    // enqueue state updates and do not need to retrigger the listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
