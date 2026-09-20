import type { Metadata } from "next";
import { requireSessionUser } from "@/lib/auth/session";
import { listAddresses } from "@/lib/addresses";
import { Button } from "@/components/ui/Button";
import { AddressForm } from "./AddressForm";
import { deleteAddressAction, setDefaultAddressAction } from "./actions";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Your addresses" };

export default async function AccountAddressesPage() {
  const user = await requireSessionUser("/account/addresses");
  const saved = await listAddresses(user.id);

  return (
    <div>
      {saved.length > 0 && (
        <ul className={styles.list}>
          {saved.map((address) => (
            <li
              key={address.id}
              className={`${styles.address} ${address.isDefault ? styles.default : ""}`}
            >
              {address.isDefault && <span className={styles.badge}>Default</span>}
              <p>
                {address.name}
                <br />
                {address.line1}
                {address.line2 ? `, ${address.line2}` : ""}
                <br />
                {address.city}, {address.state} {address.postalCode}
              </p>

              {/* Each action is passed straight to `action` so the buttons
                  work without JavaScript, like every other form here. */}
              <div className={styles.actions}>
                {!address.isDefault && (
                  <form action={setDefaultAddressAction}>
                    <input type="hidden" name="id" value={address.id} />
                    <Button type="submit">Make default</Button>
                  </form>
                )}
                <form action={deleteAddressAction}>
                  <input type="hidden" name="id" value={address.id} />
                  <Button type="submit">Remove</Button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>Add an address</h2>
      <AddressForm />
    </div>
  );
}
