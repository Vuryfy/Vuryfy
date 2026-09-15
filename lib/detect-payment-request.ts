// Payment-REQUEST detection — Sept 15, 2026.
//
// Sibling carve-out to lib/detect-payment-receipt.ts, found the same day by
// the same kind of real-world testing: the user ran a photo of their OWN
// "scan to pay" / UPI QR display card (name + UPI ID + an invitation to pay
// — no completed transaction, no amount, no transaction ID) through Quick
// Check and got "Unverified" at high confidence.
//
// Root cause is almost identical to the receipt case, but the shape is
// different enough that detect-payment-receipt.ts correctly does NOT catch
// it: a receipt claims a payment already happened (amount + a completed-
// tense verb, a transaction ID, "from"/"to" fields); a payment REQUEST card
// has none of that — it's just an identity (name, UPI ID) plus a generic
// "Scan to pay with any UPI app" caption. That's exactly the same shape
// lib/detect-payment-link.ts already handles for a machine-decoded QR
// payload — this is the text/OCR equivalent, for when the "QR" arrives as
// a screenshot of the display card (run through OCR on the Image page, or
// pasted as text) rather than a clean scannable QR image.
//
// Same underlying truth as both siblings: neither Quick Check nor Deep
// Investigation has any way to confirm who actually controls a UPI ID, so
// running this through the normal pipeline produces a misleading verdict
// for a real payee's own card. Short-circuits to an informational,
// non-verdict card instead — no AI call, no credit charged.
//
// Wired into /api/verify and /api/deep alongside detectPaymentReceipt (the
// receipt check runs first — a completed-transaction receipt should never
// be misread as a payment request even if it happens to also say "scan to
// pay" somewhere in boilerplate).
//
// Detection is a plain pattern match, not an AI call, same principle as
// both siblings. OCR of an actual QR-code graphic inside a photographed
// display card reliably comes out as visual noise (the QR's black/white
// modules get misread as stray characters/punctuation) — see the real
// example that prompted this: "hemant srivastava 1 [x] i = [x] 2 oot ore
// vib Of oe UPI ID: hemant.officialwork@okicici Scan to pay with any UPI
// app". Name extraction below deliberately only trusts the clean run of
// alphabetic words at the very start of the text (before that noise
// begins), and the raw text is always shown alongside it so a failed name
// extraction never hides information from the user.

export interface PaymentRequestInfo {
  payeeName?: string;
  payeeId?: string;
  raw: string;
}

const UPI_ID_LABELED_RE = /upi\s*id\s*[:\-]?\s*([a-z0-9][a-z0-9.\-_]{1,63}@[a-z][a-z0-9]{1,20})/i;
const UPI_ID_BARE_RE = /\b([a-z0-9][a-z0-9.\-_]{1,63}@[a-z][a-z0-9]{1,20})\b/i;

const INVITE_RE =
  /\b(scan\s*(?:to|&|and)\s*pay|scan\s*(?:this\s*)?(?:qr|code)\s*to\s*pay|pay\s*(?:with|using|via)\s*any\s*upi\s*app|pay\s*via\s*upi)\b/i;

// A completed-transaction verb + an amount means this is a receipt, not a
// request — leave it to detect-payment-receipt.ts (which runs first
// anyway, but this guards against being called standalone/out of order).
const RECEIPT_SHAPE_RE = /\b(sent|paid|received|debited|credited)\b/i;
const AMOUNT_RE = /(?:₹|rs\.?|inr)\s?\d/i;

function extractLeadingName(text: string): string | undefined {
  const words = text.trim().split(/\s+/);
  const nameWords: string[] = [];
  for (const w of words) {
    if (/^[A-Za-z]+$/.test(w) && nameWords.length < 4) {
      nameWords.push(w);
    } else {
      break;
    }
  }
  if (nameWords.length === 0) return undefined;
  // Skip generic labels that sometimes lead this kind of card and aren't a
  // person/business name (best-effort — not exhaustive).
  const joined = nameWords.join(" ").toLowerCase();
  if (["scan", "upi", "pay", "payment"].includes(nameWords[0].toLowerCase())) return undefined;
  return nameWords.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ") || joined;
}

export function detectPaymentRequest(text: string): PaymentRequestInfo | null {
  if (RECEIPT_SHAPE_RE.test(text) && AMOUNT_RE.test(text)) return null;

  const hasInvite = INVITE_RE.test(text);
  if (!hasInvite) return null;

  const labeled = text.match(UPI_ID_LABELED_RE);
  const bare = !labeled ? text.match(UPI_ID_BARE_RE) : null;
  const payeeId = labeled ? labeled[1] : bare ? bare[1] : undefined;
  if (!payeeId) return null;

  return {
    payeeName: extractLeadingName(text),
    payeeId,
    raw: text,
  };
}
