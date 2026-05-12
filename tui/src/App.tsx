import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { BrokerClient } from "./api/client.js";
import { Dashboard } from "./components/Dashboard.js";
import { TokensScreen } from "./components/TokensScreen.js";
import { AuditScreen } from "./components/AuditScreen.js";
import { PlaceholderScreen } from "./components/PlaceholderScreen.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { FocusProvider, useFocusCapture } from "./focus.js";

// Screen vocabulary mirrors web/src/App.tsx — keep the order stable so the
// number keys (1..6) map predictably across the two surfaces.
type Screen = "dashboard" | "tokens" | "audit" | "forecast" | "policy" | "shadow";

interface NavItem {
  id: Screen;
  label: string;
  hotkey: string;
  status: "live" | "stub";
}

// c1 ships Dashboard live; the other five are stubs that announce when
// they'll land. Phase 4.1 invariant 5 (focus model): number keys switch
// screens; q quits; ? shows help. Modals (c4+) will own focus exclusively.
const NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard", hotkey: "1", status: "live" },
  { id: "tokens", label: "Tokens", hotkey: "2", status: "live" },
  { id: "audit", label: "Audit", hotkey: "3", status: "live" },
  { id: "forecast", label: "Forecast", hotkey: "4", status: "stub" },
  { id: "policy", label: "Policy", hotkey: "5", status: "stub" },
  { id: "shadow", label: "Shadow AI", hotkey: "6", status: "stub" },
];

// c3 lit Audit; the remaining three are stubs.
const STUB_LANDING: Record<Exclude<Screen, "dashboard" | "tokens" | "audit">, string> = {
  forecast: "Phase 4.1 c6",
  policy: "Phase 4.1 c6",
  shadow: "Phase 4.1 c6",
};

export function App({ client }: { client: BrokerClient }) {
  return (
    <FocusProvider>
      <AppInner client={client} />
    </FocusProvider>
  );
}

function AppInner({ client }: { client: BrokerClient }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [helpOpen, setHelpOpen] = useState(false);
  const { capture } = useFocusCapture();

  // Phase 4.1 c2: when a child has captured input (search-mode TextInput
  // or detail overlay), suspend all App-level hotkeys so digits and `q`
  // don't double-fire as nav while typing.
  useInput(
    (input, key) => {
      if (helpOpen) {
        if (key.escape || input === "?" || input === "q") setHelpOpen(false);
        return;
      }
      if (input === "q" || (key.ctrl && input === "c")) {
        exit();
        return;
      }
      if (input === "?") {
        setHelpOpen(true);
        return;
      }
      const target = NAV.find((n) => n.hotkey === input);
      if (target) setScreen(target.id);
    },
    { isActive: !capture },
  );

  return (
    <Box flexDirection="column" minHeight={20}>
      <NavBar items={NAV} active={screen} brokerUrl={client.baseUrl} />
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {screen === "dashboard" ? (
          <Dashboard client={client} />
        ) : screen === "tokens" ? (
          <TokensScreen client={client} />
        ) : screen === "audit" ? (
          <AuditScreen client={client} />
        ) : (
          <PlaceholderScreen
            title={NAV.find((n) => n.id === screen)?.label ?? screen}
            shipsIn={STUB_LANDING[screen as Exclude<Screen, "dashboard" | "tokens" | "audit">]}
          />
        )}
      </Box>
      <StatusBar />
      {helpOpen ? <HelpOverlay /> : null}
    </Box>
  );
}

function NavBar({
  items,
  active,
  brokerUrl,
}: {
  items: NavItem[];
  active: Screen;
  brokerUrl: string;
}) {
  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
    >
      <Box flexDirection="row">
        <Text bold color="cyan">kb </Text>
        {items.map((item, i) => {
          const isActive = item.id === active;
          const dim = item.status === "stub";
          return (
            <Text
              key={item.id}
              color={isActive ? "cyan" : dim ? "gray" : "white"}
              bold={isActive}
            >
              {i > 0 ? "  " : ""}
              {item.hotkey}:{item.label}
            </Text>
          );
        })}
      </Box>
      <Text color="gray">{brokerUrl}</Text>
    </Box>
  );
}

function StatusBar() {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="gray">
        <Text color="white">1-6</Text> switch  <Text color="white">r</Text> refresh  <Text color="white">?</Text> help  <Text color="white">q</Text> quit
      </Text>
    </Box>
  );
}
