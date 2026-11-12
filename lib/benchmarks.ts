/**
 * Public benchmarks the product reasons with. Every number here has a source a judge can open.
 * They are benchmarks, not predictions about any one client.
 */
export const SOURCES = {
  clla: {
    label: "Commercial Law League of America, Probability of Recovering Commercial Debt with Age",
    url: "https://clla.org/wp-content/uploads/2023/Resources/Collectability-Chart-1.pdf",
    caveat: "The chart discloses no sample or method. US commercial debt, not specific to freelancers.",
  },
  quickbooks: {
    label: "Intuit QuickBooks, 2026 Small Business Late Payments Report",
    url: "https://quickbooks.intuit.com/r/small-business-data/small-business-late-payments-report-2026/",
    caveat: "US survey, about 5,000 respondents per quarter. Associations, not causes.",
  },
  bonsai: {
    label: "Bonsai, analysis of invoices from 100,000+ freelancers",
    url: "https://www.hellobonsai.com/blog/late-freelance-payment",
    caveat: "One vendor's platform data.",
  },
  owasp: {
    label: "OWASP Top 10 for LLM Applications 2025, LLM06 Excessive Agency",
    url: "https://genai.owasp.org/llmrisk/llm062025-excessive-agency/",
    caveat: "",
  },
  ap2: {
    label: "PayPal Developer Blog, Agent Payments Protocol: Building Verifiable Trust for Agentic Commerce",
    url: "https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/",
    caveat: "PayPulse Guard follows the same principle. It does not implement AP2.",
  },
} as const;

/** CLLA chart: days past the due date -> probability of collecting. */
export const CLLA_CURVE: [number, number][] = [
  [0, 0.98],
  [30, 0.94],
  [60, 0.85],
  [90, 0.74],
  [182, 0.58],
  [274, 0.43],
  [365, 0.27],
  [730, 0.14],
];

/** Linear interpolation between the published points. */
export function collectability(daysPastDue: number): number {
  const d = Math.max(0, daysPastDue);
  for (let i = 1; i < CLLA_CURVE.length; i++) {
    const [d0, p0] = CLLA_CURVE[i - 1];
    const [d1, p1] = CLLA_CURVE[i];
    if (d <= d1) return p0 + ((p1 - p0) * (d - d0)) / (d1 - d0);
  }
  return CLLA_CURVE[CLLA_CURVE.length - 1][1];
}

/** Benchmark probability lost by leaving a debt alone for `horizon` more days, in percentage points. */
export function waitCostPoints(daysPastDue: number, horizon = 30): number {
  return Math.round((collectability(daysPastDue) - collectability(daysPastDue + horizon)) * 1000) / 10;
}

/** Bonsai: share of late freelance invoices that are paid within 14 days of the due date. */
export const LATE_PAID_WITHIN_14_DAYS = 0.75;
