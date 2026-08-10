"use client";

import * as React from "react";

// Pauses periodic polling while any <select> on the page has focus.
// Works around a real Firefox stability issue: mutating a <select>'s
// containing DOM subtree (which a poll-driven React re-render does, since
// the whole card list gets replaced) while its native dropdown popup is
// open can crash Gecko — not just the tab, the whole browser process.
// Reported against the Sensors/Consoles pages' interval dropdowns, both
// of which poll every few seconds; this pauses that polling for as long
// as the dropdown might legitimately be open.
export function usePausedWhileSelectFocused(): boolean {
  const [paused, setPaused] = React.useState(false);

  React.useEffect(() => {
    function onFocusIn(e: FocusEvent) {
      if ((e.target as HTMLElement | null)?.tagName === "SELECT") setPaused(true);
    }
    function onFocusOut(e: FocusEvent) {
      if ((e.target as HTMLElement | null)?.tagName === "SELECT") setPaused(false);
    }
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  return paused;
}
