import { NextResponse } from "next/server";
import { ConfigError } from "@/lib/auth";

/**
 * Shared error wrapper for route handlers.
 *
 * Every API response in this app uses the shape `{ error: string }` for
 * failures, and the front-end reads `data.error`. This keeps that shape
 * consistent, logs the real error server-side, and never leaks internals
 * (Prisma messages, Stripe messages, stack traces) to the client.
 */

/** Throw this from anywhere inside a route body to return a specific status. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function apiError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

const GENERIC = "Something went wrong on our end. Try again in a moment.";
const MISCONFIGURED = "The server isn't configured correctly. Contact the market office.";

/**
 * Wrap a route body. Usage inside a Next app-router handler:
 *
 *   export async function POST(req: NextRequest) {
 *     return runRoute("admin/sale POST", async () => { ... });
 *   }
 *
 * A thrown HttpError becomes its own status + message (these are written for
 * the user). Anything else is logged and becomes a generic 500.
 */
export async function runRoute(label: string, body: () => Promise<Response>): Promise<Response> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof HttpError) {
      return apiError(err.message, err.status);
    }
    if (err instanceof ConfigError || (err as { isConfigError?: boolean } | null)?.isConfigError) {
      console.error(`[${label}] misconfigured:`, err instanceof Error ? err.message : err);
      return apiError(MISCONFIGURED, 500);
    }
    // Bad/absent JSON body is a client problem, not a server fault.
    if (err instanceof SyntaxError) {
      console.error(`[${label}] bad request body:`, err.message);
      return apiError("That request couldn't be read. Refresh and try again.", 400);
    }
    console.error(`[${label}] unhandled error:`, err);
    return apiError(GENERIC, 500);
  }
}

/** Wrapper form, for `export const GET = withErrors("label", async (req) => ...)`. */
export function withErrors<A extends unknown[]>(
  label: string,
  handler: (...args: A) => Promise<Response>
): (...args: A) => Promise<Response> {
  return (...args: A) => runRoute(label, () => handler(...args));
}
