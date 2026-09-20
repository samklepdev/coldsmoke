export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    // No aria-label: it would duplicate the element's own text, and in
    // SiteHeader the wrapping link's label overrides it anyway.
    <span
      style={{
        fontSize: size,
        fontWeight: 300,
        letterSpacing: "var(--track-wide)",
        background:
          "linear-gradient(90deg, var(--silver-start), var(--silver-mid), var(--silver-end))",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        whiteSpace: "nowrap",
      }}
    >
      COLDSMOKE
    </span>
  );
}
