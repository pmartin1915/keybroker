import type { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "accent" | "warning" | "danger";
}

const toneColor: Record<NonNullable<Props["tone"]>, string> = {
  default: "var(--text-primary)",
  accent: "var(--accent)",
  warning: "var(--warning)",
  danger: "var(--danger)",
};

export function StatCard({ label, value, hint, tone = "default" }: Props) {
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: toneColor[tone],
          fontFamily: "var(--font-mono)",
        }}
      >
        {value}
      </span>
      {hint ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{hint}</span>
      ) : null}
    </div>
  );
}
