"use client";

import { useActionState } from "react";
import { sendContactMessage, type ContactState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Textarea";
import styles from "./page.module.css";

/**
 * `action` receives the bound action from useActionState, which Next can still
 * serialise into a native form POST. Wrapping it in a local async function
 * would silently break the no-JS path, as the cart stepper demonstrated.
 */
export function ContactForm() {
  const [state, action, pending] = useActionState<ContactState, FormData>(
    sendContactMessage,
    { status: "idle" },
  );

  if (state.status === "sent") {
    return (
      <p role="status">
        Thanks — we have your message and will reply within two business days.
      </p>
    );
  }

  return (
    <form action={action} className={styles.form}>
      <Field label="Your email" name="email" type="email" required />
      <Field
        label="Order number (optional)"
        name="orderNumber"
        inputMode="numeric"
        error={state.status === "error" ? state.fieldErrors?.orderNumber : undefined}
      />
      <Textarea
        label="Message"
        name="message"
        required
        error={state.status === "error" ? state.fieldErrors?.message : undefined}
      />

      {/*
        Honeypot. Hidden from people, irresistible to bots that fill every
        field. Not type="hidden" -- that is the one input bots skip.
        aria-hidden and tabIndex keep it away from screen readers and keyboards.
      */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      {state.status === "error" && !state.fieldErrors && (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Sending" : "Send"}
      </Button>
    </form>
  );
}
