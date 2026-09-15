// Payment-receipt detection — Sept 15, 2026.
//
// Found via real user testing: a genuine ₹6,000 UPI payment receipt (pasted
// text, or OCR'd from a screenshot) sent through the normal text pipeline
// came back "Unverified" at 20% confidence — technically honest (there is
// no public record of a private bank-to-bank transfer for a web search to
// find) but reads as "this looks fake" for something that may be entirely
// real.
//
// This is the exact same root problem lib/detect-payment-link.ts already
// solved for payment QR codes, just showing up in text form: neither Quick
// Check nor Deep Investigation has any way to confirm a private transaction
// actually happened, so running one through the normal evidence-grounded
// pipeline produces a misleading low-confidence verdict for genuine and
// fabricated receipts alike.
//
// The motivating real-world case: someone sends a screenshot of a payment
// claiming "I already paid you" — the recipient needs some kind of response
// from Vuryfy, but a fabricated Verified/Unverified score would be actively
// misleading, since a receipt screenshot can be faked with widely available
// "fake payment" generator apps regardless of how convincing it looks. So —
// same as the QR precedent — receipt-shaped text is detected and handled
// purely informationally: extracted fields are surfaced for the user to
// sanity-check themselves, plus the one genuinely reliable piece of advice
// (check your own bank/UPI app for the actual credit) every time. No
// verdict, no confidence score, no credit charged.
//
// This runs inside /api/verify and /api/deep — the shared pipeline every
// text-shaped input funnels through (typed claims, QR-decoded text, OCR'd
// image text, audio transcripts) — so it catches a receipt regardless of
// which screen it came from (including a photographed receipt, since the
// image page's OCR step already sends extracted text through this exact
// same endpoint), without needing separate detection wired into every
// calling page.
//
// Detection is a plain keyword/pattern score, deliberately not an AI call —
// same "don't ask a model to judge something a regex can already tell you"
// principle as detect-payment-link.ts. Requires signals from at least two
// different categories before calling something a receipt, so an ordinary
// claim that happens to mention "UPI" or a bank name once doesn't get
// misrouted away from a real fact-check.
//
// Field extraction below is deliberately best-effort only — OCR'd receipts
// are often garbled (see the real example that prompted this: "Google
// transaction ID CICAGNjtrousiQ"). The raw text is always shown alongside
// whatever was extracted, so a failed or partial extraction never hides
// information from the user.

const APP_NAMES = [
  "paytm",
  "phonepe",
  "google pay",
  "gpay",
  "bhim",
  "amazon pay",
  "cred",
  "bharatpe",
  "whatsapp pay",
  "mobikwik",
];

const BANK_NAMES = [
  "icici",
  "hdfc",
  "sbi",
  "state bank",
  "axis",
  "kotak",
  "yes bank",
  "pnb",
  "punjab national",
  "bank of baroda",
  "canara",
  "idfc",
  "indusind",
  "union bank",
];

export interface PaymentReceiptInfo {
  amount?: string;
  fromName?: string;
  toName?: string;
  transactionId?: string;
  appUsed?: string;
  date?: string;
  raw: string;
}

function findAppUsed(lower: string): string | undefined {
  const found = APP_NAMES.find((app) => lower.includes(app));
  if (!found) return undefined;
  // Title-case for display ("google pay" -> "Google Pay")
  return found.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function detectPaymentReceipt(text: string): PaymentReceiptInfo | null {
  const lower = text.toLowerCase();
  let score = 0;

  const hasTxnId =
    /\b(upi|google|paytm)?\s*transaction id\b/.test(lower) ||
    /\butr\b/.test(lower) ||
    /reference (no|number)/.test(lower);
  if (hasTxnId) score++;

  const hasApp = APP_NAMES.some((app) => lower.includes(app));
  if (hasApp) score++;

  const hasBank = BANK_NAMES.some((bank) => lower.includes(bank));
  if (hasBank) score++;

  const hasAmountVerb =
    (/(₹|rs\.?|inr)\s?[\d,]+/.test(lower) || /\b[\d,]{3,}\b/.test(lower)) &&
    /\b(sent|paid|received|debited|credited|completed)\b/.test(lower);
  if (hasAmountVerb) score++;

  const hasFromTo = /\bfrom\s*[:\-]?\s*\S/.test(lower) && /\bto\s*[:\-]?\s*\S/.test(lower);
  if (hasFromTo) score++;

  const hasBoilerplate = /payments? may take (up to )?\d+ (working )?days?/.test(lower);
  if (hasBoilerplate) score++;

  if (score < 2) return null;

  const amountMatch =
    text.match(/(?:₹|rs\.?|inr)\s?([\d][\d,]*(?:\.\d{1,2})?)/i) ||
    text.match(/\b([\d][\d,]{2,})\b\s*(?:\/-)?\s*(?:sent|paid|received|debited|credited)/i) ||
    text.match(/(?:sent|paid|received|debited|credited)\D{0,15}?([\d][\d,]{2,})/i);
  const txnIdMatch = text.match(/(?:upi |google |paytm )?transaction id\s*[:\-]?\s*([a-z0-9]{6,})/i);
  const fromMatch = text.match(/\bfrom\s*[:\-]?\s*([a-z][a-z .]{2,40}?)(?=\s{2,}|\s+(?:paytm|google pay|gpay|phonepe|bhim|to\b)|$)/i);
  const toMatch = text.match(/\bto\s*[:\-]?\s*([a-z][a-z .]{2,40}?)(?=\s{2,}|\s+(?:paytm|google pay|gpay|phonepe|bhim|from\b)|$)/i);
  const dateMatch = text.match(/\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/i);

  return {
    amount: amountMatch ? amountMatch[1] : undefined,
    fromName: fromMatch ? fromMatch[1].trim() : undefined,
    toName: toMatch ? toMatch[1].trim() : undefined,
    transactionId: txnIdMatch ? txnIdMatch[1] : undefined,
    appUsed: findAppUsed(lower),
    date: dateMatch ? dateMatch[0] : undefined,
    raw: text,
  };
}
