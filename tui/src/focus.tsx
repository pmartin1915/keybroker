import React, { createContext, useCallback, useContext, useState } from "react";

// Phase 4.1 c2 — input capture gate.
//
// Ink's useInput delivers the same key event to every registered handler,
// so an inline TextInput (search mode in TokensScreen, JWT prompt in c4)
// cannot prevent App-level hotkeys (1..6 / q / r / ?) from firing on the
// same keystroke. The fix is cooperative: a context flag children flip
// when they own input, and App reads to gate its own useInput via the
// { isActive } option.
//
// This is the seed of the c4+ modal-stack pattern (invariant 5). For
// now it's a single boolean; if c4 nests modals it upgrades to a stack
// reducer without a router (invariant 10).

interface FocusState {
  capture: boolean;
  setCapture: (next: boolean) => void;
}

const FocusContext = createContext<FocusState>({
  capture: false,
  setCapture: () => {},
});

export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [capture, setCaptureRaw] = useState(false);
  const setCapture = useCallback((next: boolean) => setCaptureRaw(next), []);
  return (
    <FocusContext.Provider value={{ capture, setCapture }}>
      {children}
    </FocusContext.Provider>
  );
}

export function useFocusCapture(): FocusState {
  return useContext(FocusContext);
}
