import type { ButtonHTMLAttributes, ReactNode } from "react";
import Link, { type LinkProps } from "next/link";
import styles from "./Button.module.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "quiet";
  block?: boolean;
};

function buttonClasses(
  variant: "primary" | "outline" | "quiet",
  block: boolean,
  className?: string,
) {
  return [
    styles.base,
    variant === "primary" && styles.primary,
    variant === "quiet" && styles.quiet,
    block && styles.block,
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "outline",
  block = false,
  className,
  ...rest
}: Props) {
  return <button className={buttonClasses(variant, block, className)} {...rest} />;
}

/**
 * A link that looks like a button.
 *
 * Use this instead of wrapping <Button> in <Link>. Nesting a <button> inside
 * an <a> is invalid HTML: it gives keyboard users two tab stops for one
 * control and leaves screen readers to guess which element to announce.
 */
export function ButtonLink({
  href,
  variant = "outline",
  block = false,
  className,
  children,
  ...rest
}: Omit<LinkProps, "className"> & {
  variant?: "primary" | "outline" | "quiet";
  block?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClasses(variant, block, className)} {...rest}>
      {children}
    </Link>
  );
}
