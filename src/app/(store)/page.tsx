import { Wordmark } from "@/components/ui/Wordmark";
import { ButtonLink } from "@/components/ui/Button";
import styles from "./page.module.css";

const NOTES = [
  { layer: "Top", body: "Bergamot, iced spearmint, black and pink pepper." },
  { layer: "Heart", body: "Cardamom, clary sage, a whisper of cinnamon, lavender." },
  { layer: "Base", body: "Dark musk, amber, cedarwood, patchouli, smoky vetiver." },
];

export default function HomePage() {
  return (
    <>
      <section className={styles.hero}>
        <div>
          <Wordmark size={40} />
          <h1 className={styles.tagline}>Cold air. Dark spice.</h1>
          <p className={styles.sub}>
            A crisp icy opening that burns down into spice, musk, and a wisp of
            smoke. Cold up top. Smoke underneath.
          </p>
          <div className={styles.cta}>
            <ButtonLink href="/shop" variant="primary">
              Shop
            </ButtonLink>
            <ButtonLink href="/the-scent">The scent</ButtonLink>
          </div>
        </div>
      </section>

      <section className={styles.notes} aria-label="Scent notes">
        {NOTES.map((note) => (
          <div key={note.layer} className={styles.note}>
            <h2>{note.layer}</h2>
            <p>{note.body}</p>
          </div>
        ))}
      </section>
    </>
  );
}
