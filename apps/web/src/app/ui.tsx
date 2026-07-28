"use client";

import { useActionState } from "react";

import type { ActionResult } from "./actions";

const EMPTY: ActionResult = {};

/**
 * A form bound to a server action, showing whatever the API refused.
 *
 * Failures are displayed with their code rather than swallowed: a Member
 * pressing Approve *should* see `PERMISSION_DENIED`, because that boundary is
 * the product working, not an error to hide.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  variant = "primary",
  confirmDisabled = false,
}: {
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
  submitLabel: string;
  children?: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  confirmDisabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY);

  return (
    <form action={formAction}>
      {state.error && (
        <p className="error">
          <code>{state.error.code}</code> — {state.error.message}
        </p>
      )}
      {children}
      <button
        type="submit"
        className={variant === "primary" ? undefined : variant}
        disabled={pending || confirmDisabled}
      >
        {pending ? "Working…" : submitLabel}
      </button>
    </form>
  );
}
