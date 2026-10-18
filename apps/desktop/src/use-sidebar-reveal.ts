import { useEffect, useRef, useState } from "react";
import type { FocusEvent } from "react";

/** How long the pointer rests on the edge before the hidden sidebar shows. */
export const REVEAL_DELAY_MS = 150;

/**
 * Showing and hiding the sidebar in compact mode. The pointer on the edge for 150 ms shows it;
 * leaving it hides it again. Keyboard focus inside it keeps it shown (a click does not), so Tab can
 * reach a hidden sidebar. Outside compact mode `revealed` is always false and nothing is tracked.
 */
export function useSidebarReveal(enabled: boolean) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return {
    revealed: enabled && (hover || focused),
    /** For the strip on the screen edge that asks for the sidebar. */
    edge: {
      onMouseEnter: () => {
        cancel();
        timer.current = window.setTimeout(() => {
          timer.current = undefined;
          setHover(true);
        }, REVEAL_DELAY_MS);
      },
      onMouseLeave: cancel,
    },
    /** For the sidebar itself. */
    sidebar: {
      onMouseEnter: () => {
        cancel();
        setHover(true);
      },
      onMouseLeave: () => {
        cancel();
        setHover(false);
      },
      onFocus: (event: FocusEvent<HTMLElement>) => {
        if (event.target.matches(":focus-visible")) setFocused(true);
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      },
    },
  };
}
