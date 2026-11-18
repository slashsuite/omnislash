// ob 352 -- the one error a handler throws to choose its own status and code.
//
// Its own module rather than a member of server.ts, so handlers.ts can throw it without importing the
// router (and the router can catch it without importing every handler).
import type { ObApiErrorCode } from "./contract.ts";

/**
 * A refusal with a deliberate shape: a machine-readable `code`, an HTTP status, and a message written for
 * the person reading the terminal. Anything else a handler throws becomes a 500 `internal` with the
 * thrown message and no stack -- deliberate, because an unplanned throw's message is the only part of it
 * that is safe to hand to a client.
 */
export class ApiFault extends Error {
  constructor(
    readonly code: ObApiErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiFault";
  }
}
