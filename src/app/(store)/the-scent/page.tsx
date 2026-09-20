import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "The Scent",
  description:
    "Coldsmoke opens cold and burns down into spice, musk and smoke. Bergamot, iced spearmint and black pepper over cardamom, clary sage and lavender.",
};

export default function TheScentPage() {
  return (
    <ContentPage title="The Scent" lede="Cold air. Dark spice.">
      {/*
        A <dl> rather than three divs: each band is a term and its notes are
        that term's definition, which is exactly the semantic a screen reader
        should announce. The widening shape is visual only.
      */}
      <dl className={styles.pyramid}>
        <div className={`${styles.band} ${styles.top}`}>
          <dt className={styles.label}>Top</dt>
          <dd className={styles.notes}>
            Bergamot · Iced spearmint · Black pepper
          </dd>
        </div>

        <div className={`${styles.rule} ${styles.ruleTop}`} />

        <div className={`${styles.band} ${styles.heart}`}>
          <dt className={styles.label}>Heart</dt>
          <dd className={styles.notes}>Cardamom · Clary sage · Lavender</dd>
        </div>

        <div className={`${styles.rule} ${styles.ruleHeart}`} />

        <div className={`${styles.band} ${styles.base}`}>
          <dt className={styles.label}>Base</dt>
          <dd className={styles.notes}>
            Dark musk · Amber · Cedarwood · Smoky vetiver
          </dd>
        </div>
      </dl>

      <h2>How it wears</h2>
      <p>
        The opening is cold and sharp — citrus peel and iced mint over pepper.
        It does not stay there. Within the hour the cold burns off and the
        spice comes up: cardamom and clary sage, softened by lavender.
      </p>
      <p>
        What remains after that is the part the bottle is named for. Dark musk
        and amber over cedar, with vetiver reading as smoke rather than earth.
        It sits close to the skin and lasts most of a day.
      </p>

      <h2>Materials</h2>
      <p>
        Blended and bottled in small batches. No filler, no reformulation
        between batches, and nothing in the formula that is there to make the
        first ten seconds louder than the next ten hours.
      </p>

      <h2>Not sure yet</h2>
      <p>
        The 2 mL sample is about twenty sprays — enough to wear it for a few
        days and learn how it dries down on your skin. Buy the sample first.
        It is the honest way to sell a scent you cannot smell through a screen.
      </p>
    </ContentPage>
  );
}
