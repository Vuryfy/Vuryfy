// Payment-QR detection — Sept 14, 2026.
//
// Found while testing QR decode with a real UPI payment QR: Quick Check's
// web-search pipeline has no way to confirm who actually controls a UPI ID
// or payment link — there's no public source that says "this VPA belongs
// to a legitimate business." Running a payment QR through the normal
// fact-checking pipeline produces a low-confidence "Unverified" for every
// payment QR, legitimate or fraudulent alike — it doesn't protect anyone
// and makes legitimate businesses look suspicious. So payment links are
// detected and handled separately, informationally, before ever reaching
// /api/verify: no AI call, no search, no verdict, no credit charged.
//
// UPI's upi://pay?... deep-link scheme is what every Indian UPI app (GPay,
// PhonePe, Paytm, BharatPe, etc.) generates, regardless of which app made
// the QR code, so matching the upi:// scheme covers the large majority of
// Indian payment QR codes. A couple of common non-UPI payment-link
// patterns are matched too, but this list isn't exhaustive — expand it as
// more get reported.
const NON_UPI_PAYMENT_LINK_PATTERNS = [/paypal\.me\//i, /razorpay\.me\//i, /cash\.app\//i];

export interface PaymentLinkInfo {
  kind: "upi" | "payment-link";
  payeeName?: string;
  payeeId?: string;
  amount?: string;
  currency?: string;
  raw: string;
}

export function detectPaymentLink(decoded: string): PaymentLinkInfo | null {
  const trimmed = decoded.trim();

  if (/^upi:\/\//i.test(trimmed)) {
    // upi://pay?pa=...&pn=...&am=...&cu=...&tn=... isn't a URL scheme
    // browsers parse natively, so pull the query params out by hand
    // rather than relying on `new URL()`.
    const queryStart = trimmed.indexOf("?");
    const params = new URLSearchParams(queryStart >= 0 ? trimmed.slice(queryStart + 1) : "");
    return {
      kind: "upi",
      payeeName: params.get("pn") ?? undefined,
      payeeId: params.get("pa") ?? undefined,
      amount: params.get("am") ?? undefined,
      currency: params.get("cu") ?? undefined,
      raw: trimmed,
    };
  }

  if (NON_UPI_PAYMENT_LINK_PATTERNS.some((re) => re.test(trimmed))) {
    return { kind: "payment-link", raw: trimmed };
  }

  return null;
}
