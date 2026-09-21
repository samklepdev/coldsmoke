/**
 * A placeholder so /admin/orders is a real route.
 *
 * Without a page here, Next.js has nothing to match under /admin/orders and
 * serves the global 404 without ever rendering AdminLayout -- so
 * requireAdminUser's redirect and notFound() never run, and the boundary
 * this task exists to build goes untested. Task 7 replaces this with the
 * real orders list.
 */
export default function OrdersPlaceholderPage() {
  return <p>Orders is coming in a later task.</p>;
}
