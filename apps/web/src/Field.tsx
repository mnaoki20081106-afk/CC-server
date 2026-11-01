import { ReactNode } from "react";

// Ported verbatim from xaccount-bot's apps/web/src/App.tsx (function Field).
export default function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
