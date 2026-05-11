import { useState } from "react";
import { Dashboard } from "./components/Dashboard.js";
import { TokensScreen } from "./components/TokensScreen.js";
import { AuditScreen } from "./components/AuditScreen.js";

type Screen = "dashboard" | "tokens" | "audit";

interface NavItem {
  id: Screen;
  label: string;
}

const NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "tokens", label: "Tokens" },
  { id: "audit", label: "Audit" },
];

const FUTURE_NAV: { label: string; phase: string }[] = [
  { label: "Forecast", phase: "4.0 c3" },
  { label: "Policy", phase: "4.0 c3" },
  { label: "Shadow AI", phase: "4.0 c3" },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>("dashboard");

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <aside
        style={{
          width: 220,
          background: "var(--bg-paper)",
          borderRight: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: "18px 20px",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: "var(--accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--bg-ink)",
              fontWeight: 800,
              fontSize: 14,
            }}
          >
            kb
          </div>
          <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: "-0.01em" }}>
            Keybroker
          </span>
        </div>
        <nav
          style={{
            flex: 1,
            padding: "8px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {NAV.map((n) => {
            const active = screen === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setScreen(n.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  borderRadius: "var(--radius-sm)",
                  border: "none",
                  background: active ? "var(--bg-elevated)" : "transparent",
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  borderLeft: active ? "3px solid var(--accent)" : "3px solid transparent",
                }}
              >
                {n.label}
              </button>
            );
          })}
          <div style={{ marginTop: 16, padding: "0 12px" }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--text-muted)",
              }}
            >
              Coming next
            </span>
          </div>
          {FUTURE_NAV.map((n) => (
            <div
              key={n.label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "6px 12px",
                color: "var(--text-muted)",
                fontSize: 12,
                cursor: "not-allowed",
              }}
            >
              <span>{n.label}</span>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}>{n.phase}</span>
            </div>
          ))}
        </nav>
        <div
          style={{
            padding: 12,
            borderTop: "1px solid var(--border-subtle)",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          Phase 4.0 · c2 read-only
        </div>
      </aside>

      <main style={{ flex: 1, overflow: "auto", background: "var(--bg-ink)" }}>
        {screen === "dashboard" && <Dashboard />}
        {screen === "tokens" && <TokensScreen />}
        {screen === "audit" && <AuditScreen />}
      </main>
    </div>
  );
}
