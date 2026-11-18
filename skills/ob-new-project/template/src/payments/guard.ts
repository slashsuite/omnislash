/**
 * Every charge, payout and refund goes through `guardedPayment`. A smoke account can never
 * reach a live-mode provider call, whatever keys the runtime happens to hold.
 */
export interface PaymentContext {
  account: { id: string; isSmoke: boolean };
  /** The provider secret key the call will use. The mode is read from it, never passed in. */
  key: string;
}

export class SmokePaymentRefused extends Error {
  constructor(accountId: string) {
    super(`refused a live-mode payment for smoke account ${accountId}`);
    this.name = "SmokePaymentRefused";
  }
}

/** Fails closed: a key is test-mode only if it carries a known test prefix. Add your provider's. */
const TEST_KEY_PREFIXES = ["sk_test_", "rk_test_"];
const isTestKey = (key: string) => TEST_KEY_PREFIXES.some((p) => key.startsWith(p));

export async function guardedPayment<T>(ctx: PaymentContext, call: () => Promise<T>): Promise<T> {
  if (ctx.account.isSmoke && !isTestKey(ctx.key)) {
    throw new SmokePaymentRefused(ctx.account.id);
  }
  return call();
}
