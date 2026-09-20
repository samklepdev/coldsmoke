import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";

export const metadata: Metadata = {
  title: "About",
  description: "One scent, made in small batches, sold direct.",
};

export default function AboutPage() {
  return (
    <ContentPage title="About" lede="One scent. Made in small batches.">
      <h2>Why one scent</h2>
      <p>
        Most fragrance houses launch a range and hope one of them works.
        Coldsmoke is a single formula, revised until it was right and then left
        alone. A range would mean spreading the same attention thinner.
      </p>

      <h2>The name</h2>
      <p>
        Cold smoke is what comes off a fire that has gone out — the smell of
        the air after, not during. That gap between cold and warm is the whole
        idea of the scent: it opens like winter air and ends like the room the
        fire was in.
      </p>

      <h2>How it is sold</h2>
      <p>
        Direct, with no retail markup and no middle tier. That is also why the
        sample exists and why it costs six dollars: buying a bottle of
        something you have never smelled is a bad deal, and pretending
        otherwise is how fragrance is usually sold.
      </p>
    </ContentPage>
  );
}
