"use client";

import { useId, type SelectHTMLAttributes } from "react";
import styles from "./Field.module.css";

type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string;
};

/**
 * The select counterpart to `Field`.
 *
 * It imports Field's stylesheet rather than owning a copy: an input and a
 * select sit side by side in the address row, and two stylesheets would drift
 * -- one border colour updated, the other forgotten. The native chevron is
 * kept, so there is nothing to style around.
 */
export function Select({ label, error, className, children, ...rest }: Props) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className={styles.wrap}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={[styles.input, error && styles.invalid, className]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      >
        {children}
      </select>
      {error && (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
