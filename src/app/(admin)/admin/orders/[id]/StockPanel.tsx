"use client";

import { useActionState, useState } from "react";
import { restockAction, writeOffAction, type StockState } from "./actions";
import { Button } from "@/components/ui/Button";

type Line = {
  id: string;
  name: string;
  quantity: number;
  restockedQuantity: number;
};

/**
 * What happens to the stock of a refunded order.
 *
 * Refunding returns money; whether the goods come back is a separate question
 * only a human can answer -- an unshipped order is resalable, an opened bottle
 * is not. So this asks rather than inferring, and a refund with no answer yet
 * stays visible instead of silently deciding nothing.
 */
export function StockPanel({
  orderId,
  lines,
  decided,
}: {
  orderId: string;
  lines: Line[];
  decided: boolean;
}) {
  const [reopened, setReopened] = useState(false);
  const [state, action, pending] = useActionState<StockState, FormData>(
    restockAction,
    { status: "idle" },
  );

  const remaining = lines.reduce(
    (total, line) => total + (line.quantity - line.restockedQuantity),
    0,
  );

  if (state.status === "restocked") {
    return <p role="status">{state.units} returned to stock.</p>;
  }

  if (decided && !reopened) {
    const restocked = lines.reduce(
      (total, line) => total + line.restockedQuantity,
      0,
    );

    return (
      <div>
        <p>
          {restocked > 0
            ? `${restocked} returned to stock.`
            : "Written off. Stock unchanged."}
        </p>
        {remaining > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setReopened(true)}
          >
            Restock more
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      <form action={action}>
        <input type="hidden" name="orderId" value={orderId} />

        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Ordered</th>
              <th>Already restocked</th>
              <th>Return to stock</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.name}</td>
                <td>{line.quantity}</td>
                <td>{line.restockedQuantity}</td>
                <td>
                  <input
                    type="number"
                    name={`quantity:${line.id}`}
                    min={0}
                    max={line.quantity - line.restockedQuantity}
                    defaultValue={line.quantity - line.restockedQuantity}
                    aria-label={`Units of ${line.name} to return to stock`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {state.status === "error" && <p role="alert">{state.error}</p>}

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Returning" : "Return to stock"}
        </Button>
      </form>

      <WriteOffForm orderId={orderId} />
    </>
  );
}

/**
 * Its own form and its own action state.
 *
 * `formAction={writeOffAction}` on a button inside the restock form does NOT
 * work: useActionState actions take (prevState, formData), so React would pass
 * FormData as prevState and nothing as formData. Two forms is the shape the
 * rest of this directory already uses -- see ResendPrompt in FulfillForm.tsx.
 */
function WriteOffForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState<StockState, FormData>(
    writeOffAction,
    { status: "idle" },
  );

  if (state.status === "written-off") {
    return <p role="status">Written off. Stock unchanged.</p>;
  }

  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      {state.status === "error" && <p role="alert">{state.error}</p>}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Saving" : "Write off"}
      </Button>
    </form>
  );
}
