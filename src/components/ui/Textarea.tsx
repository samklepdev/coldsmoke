"use client";

import { useId, type TextareaHTMLAttributes } from "react";
import styles from "./Textarea.module.css";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  error?: string;
};

/** `Field`'s sibling. Field wraps <input>, which cannot be multi-line. */
export function Textarea({ label, error, className, ...rest }: Props) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className={styles.wrap}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className={[styles.input, error && styles.invalid, className]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
      {error && (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
