import "dotenv/config";
import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";

async function main() {
  const body = { name: "T", email: `dup-${Date.now()}@example.com`, password: "a long enough password" };
  const first = await auth.api.signUpEmail({ body, headers: new Headers() });
  console.log("first ok, user id:", first.user.id);
  try {
    const second = await auth.api.signUpEmail({ body, headers: new Headers() });
    console.log("SECOND DID NOT THROW. returned user id:", second.user.id);
  } catch (err) {
    console.log("SECOND THREW:", err instanceof APIError ? "APIError" : typeof err);
    if (err instanceof APIError) {
      console.log("  status:", err.status);
      console.log("  body.code:", JSON.stringify(err.body?.code));
      console.log("  body.message:", JSON.stringify(err.body?.message));
    }
  }
  console.log("expected code:", auth.$ERROR_CODES.USER_ALREADY_EXISTS.code);
}
main();
