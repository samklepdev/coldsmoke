import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Hr,
  Row,
  Column,
} from "@react-email/components";
import { formatCents } from "@/lib/money";
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

export function OrderConfirmation({ order }: { order: OrderWithItems }) {
  const address = order.shippingAddress;

  return (
    <Html>
      <Head />
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.wordmark}>COLDSMOKE</Text>
          <Hr style={styles.hr} />

          <Text style={styles.text}>
            Your order is confirmed. {formatOrderNumber(order.orderNumber)}.
          </Text>
          <Text style={styles.text}>
            We&apos;ll email you again when it ships.
          </Text>

          <Hr style={styles.hr} />
          <Text style={styles.label}>Order</Text>

          {order.items.map((item) => (
            <Row key={item.id}>
              <Column>
                <Text style={styles.text}>
                  {item.name} × {item.quantity}
                </Text>
              </Column>
              <Column align="right">
                <Text style={styles.bright}>{formatCents(item.totalCents)}</Text>
              </Column>
            </Row>
          ))}

          <Hr style={styles.hr} />

          <SummaryRow label="Subtotal" value={formatCents(order.subtotalCents)} />
          {order.discountCents > 0 && (
            <SummaryRow label="Discount" value={`-${formatCents(order.discountCents)}`} />
          )}
          <SummaryRow
            label="Shipping"
            value={order.shippingCents === 0 ? "Free" : formatCents(order.shippingCents)}
          />
          <SummaryRow label="Tax" value={formatCents(order.taxCents)} />
          <SummaryRow label="Total" value={formatCents(order.totalCents)} />

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

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <Column>
        <Text style={styles.text}>{label}</Text>
      </Column>
      <Column align="right">
        <Text style={styles.bright}>{value}</Text>
      </Column>
    </Row>
  );
}
