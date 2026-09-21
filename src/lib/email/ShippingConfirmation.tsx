import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Hr,
} from "@react-email/components";
import { formatOrderNumber } from "@/lib/orders/format";
import type { OrderWithItems } from "@/lib/orders";

const styles = {
  body: { background: "#0a0a0c", color: "#b7bbc1", fontFamily: "Helvetica, Arial, sans-serif", margin: 0 },
  container: { maxWidth: "540px", margin: "0 auto", padding: "40px 24px" },
  wordmark: { color: "#e4e7ec", fontSize: "20px", letterSpacing: "6px", fontWeight: 300, margin: 0 },
  label: { color: "#8d9198", fontSize: "11px", letterSpacing: "2px", textTransform: "uppercase" as const },
  text: { color: "#b7bbc1", fontSize: "14px", lineHeight: "22px" },
  bright: { color: "#d2d5da", fontSize: "14px" },
  hr: { borderColor: "#3e3f45", margin: "24px 0" },
};

export function ShippingConfirmation({ order }: { order: OrderWithItems }) {
  const address = order.shippingAddress;

  return (
    <Html>
      <Head />
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.wordmark}>COLDSMOKE</Text>
          <Hr style={styles.hr} />

          <Text style={styles.text}>
            {formatOrderNumber(order.orderNumber)} is on its way.
          </Text>

          <Hr style={styles.hr} />
          <Text style={styles.label}>Carrier</Text>
          <Text style={styles.bright}>{order.carrier}</Text>

          <Text style={styles.label}>Tracking number</Text>
          <Text style={styles.bright}>{order.trackingNumber}</Text>

          <Text style={{ ...styles.text, color: "#63666d", fontSize: "12px" }}>
            Tracking can take a day to show movement after a parcel is booked in.
          </Text>

          <Hr style={styles.hr} />
          <Text style={styles.label}>Shipping to</Text>
          <Text style={styles.text}>
            {address.name}
            <br />
            {address.line1}
            {address.line2 ? <><br />{address.line2}</> : null}
            <br />
            {address.city}, {address.state} {address.postalCode}
          </Text>

          <Hr style={styles.hr} />
          <Text style={{ ...styles.text, color: "#63666d", fontSize: "12px" }}>
            Questions or to report an adverse event: care@wearcoldsmoke.com
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
