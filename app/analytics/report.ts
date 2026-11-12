import type { AgDataSourcesDefinition, AgFieldDefinition, AgReportState } from "ag-studio";
import type { AnalyticsData } from "@/lib/analytics";

/** Field definitions and the prebuilt report for the AG Studio analytics page. */

// Dates arrive as ISO strings over JSON; Studio wants Date objects.
const date = (key: string): any => (row: any) => (row[key] ? new Date(row[key]) : null);

export function dataSources(d: AnalyticsData): AgDataSourcesDefinition {
  const money: Pick<AgFieldDefinition, "format" | "formatOptions"> = {
    format: "currencyFormat",
    formatOptions: { format: new Intl.NumberFormat("en-US", { style: "currency", currency: d.currency, maximumFractionDigits: 0 }) },
  };
  const text = (id: string, name: string, description?: string): AgFieldDefinition => ({ id, name, description, format: "textFormat" });
  const int = (id: string, name: string, description?: string): AgFieldDefinition => ({ id, name, description, format: "integerFormat" });
  return {
    description:
      "Collections data for a small business that invoices through PayPal. Invoices come from PayPal Invoicing. Agent proposals are actions AI agents asked to take (reminders, settlement discounts, dispute concessions); a guard checked each one against the owner's mandate. Refusals are every time the guard said no. Money is in " +
      d.currency +
      ".",
    sources: [
      {
        id: "invoices",
        name: "Invoices",
        description: "Every sent invoice on the PayPal account, with how late it is, how late the client usually pays, and a public collectability benchmark.",
        primaryKeyField: "invoice_id",
        data: d.invoices,
        fields: [
          { ...text("invoice_id", "PayPal invoice id"), hide: true },
          text("invoice", "Invoice"),
          text("client", "Client"),
          text("milestone", "Milestone"),
          text("state", "State", "Late, not due yet, paid or cancelled."),
          text("age_bucket", "Age", "How far past the due date an unpaid invoice is."),
          { ...int("age_order", "Age order"), hide: true },
          { id: "amount", name: "Invoice total", ...money },
          { id: "amount_due", name: "Owed", description: "Still unpaid.", ...money },
          { id: "late_amount", name: "Late", description: "Unpaid and past its due date.", ...money },
          { id: "paid_amount", name: "Paid", ...money },
          { id: "due_date", name: "Due date", format: "dateFormat", accessor: date("due_date") },
          int("days_late", "Days late"),
          { id: "usual_days_late", name: "Usually late by", description: "Average days late across this client's paid invoices on PayPal.", format: "decimalFormat", formatOptions: { format: new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }) } },
          { id: "beyond_usual", name: "Days beyond their usual", format: "decimalFormat" },
          { id: "collectability", name: "Collectability", description: "Public benchmark (Commercial Law League of America) for commercial debt this late.", format: "percentageFormat" },
          { id: "at_risk", name: "At risk", description: "Benchmark shortfall: owed multiplied by one minus collectability.", ...money },
          text("last_agent_action", "Last agent action"),
        ],
      },
      {
        id: "actions",
        name: "Agent proposals",
        description: "Every action an AI agent proposed: the built-in agent, outside agents over MCP, and the simulated red team. Outcome says what the guard and the owner did with it.",
        primaryKeyField: "proposal_id",
        data: d.actions,
        fields: [
          text("proposal_id", "Proposals"),
          { id: "proposed_at", name: "Proposed at", format: "dateTimeFormat", accessor: date("proposed_at") },
          text("proposed_by", "Proposed by"),
          text("model", "Model"),
          text("action", "Action"),
          text("target", "Invoice or dispute"),
          { ...text("action_invoice_id", "PayPal invoice id"), hide: true },
          text("action_client", "Client"),
          text("outcome", "Outcome"),
          { id: "discount_pct", name: "Discount %", format: "decimalFormat" },
          { id: "given_up", name: "Would give up", ...money },
          { id: "given_up_executed", name: "Given up", description: "Money given up by actions that ran.", ...money },
          { id: "stopped_amount", name: "Stopped", description: "Money that blocked proposals and attacks would have given up.", ...money },
          int("rules_broken", "Rules broken"),
          text("first_broken_rule", "First rule broken"),
        ],
      },
      {
        id: "refusals",
        name: "Guard refusals",
        description: "One row per reason the guard refused something: a mandate rule a proposal broke, or a signature, autopilot or key check that failed.",
        primaryKeyField: "refusal_id",
        data: d.refusals,
        fields: [
          text("refusal_id", "Refusals"),
          { id: "refused_at", name: "Refused at", format: "dateTimeFormat", accessor: date("refused_at") },
          text("stage", "Gate"),
          text("reason", "Reason"),
          text("refused_who", "Who was refused"),
          { id: "refused_amount", name: "Amount involved", ...money },
        ],
      },
      {
        id: "ledger",
        name: "Audit ledger",
        description: "The hash-chained audit ledger: every proposal, refusal, signature and PayPal call.",
        primaryKeyField: "seq",
        data: d.ledger,
        fields: [
          int("seq", "Entry"),
          { id: "logged_at", name: "Logged at", format: "dateTimeFormat", accessor: date("logged_at") },
          text("actor", "Who"),
          text("event", "Event"),
          text("result", "Result"),
          text("subject", "Subject"),
          { id: "ledger_amount", name: "Amount", ...money },
          text("detail", "Detail"),
        ],
      },
    ],
    relationships: [{ id: "proposal_invoice", type: "many-to-one", source: "actions.action_invoice_id", target: "invoices.invoice_id" }],
  };
}

const title = (text: string, caption?: string) => ({
  title: { text, enabled: true },
  ...(caption ? { caption: { text: caption, enabled: true } } : {}),
});
const legend = (position: string) => ({ style: { theme: { common: { legend: { enabled: true, position } } } } });

export const initialReport: AgReportState = {
  selectedPageId: "collections",
  pages: [
    {
      id: "collections",
      widgets: {
        money: {
          type: "multi-kpi",
          format: { ...title("Money on the line"), style: { columns: 4 } },
          dataMapping: {
            values: [
              { id: "invoices.amount_due", aggregation: "sum" },
              { id: "invoices.late_amount", aggregation: "sum" },
              { id: "invoices.at_risk", aggregation: "sum" },
              { id: "invoices.paid_amount", aggregation: "sum" },
            ],
          },
        },
        agents: {
          type: "multi-kpi",
          format: { ...title("What the agents did"), style: { columns: 3 } },
          dataMapping: {
            values: [
              { id: "actions.proposal_id", aggregation: "count" },
              { id: "actions.given_up_executed", aggregation: "sum" },
              { id: "actions.stopped_amount", aggregation: "sum" },
            ],
          },
        },
        age: {
          type: "column-chart-grouped",
          format: title("Unpaid money by age", "Click any bar or slice to filter the page."),
          dataMapping: { categoryKey: [{ id: "invoices.age_bucket" }], valueKey: [{ id: "invoices.amount_due", aggregation: "sum" }] },
        },
        pattern: {
          type: "bar-chart-grouped",
          format: { ...title("Days late, against their usual", "Their usual comes from each client's paid invoices on PayPal."), ...legend("bottom") },
          dataMapping: { categoryKey: [{ id: "invoices.client" }], valueKey: [{ id: "invoices.days_late", aggregation: "max" }, { id: "invoices.usual_days_late", aggregation: "max" }] },
        },
        outcomes: {
          type: "donut-chart",
          format: { ...title("Proposal outcomes"), ...legend("right") },
          dataMapping: { categoryKey: [{ id: "actions.outcome" }], valueKey: [{ id: "actions.proposal_id", aggregation: "count" }] },
        },
        byAgent: {
          type: "column-chart-stacked",
          format: { ...title("Every agent, same guard", "Built-in agent, outside agents over MCP, and the red team."), ...legend("right") },
          dataMapping: { categoryKey: [{ id: "actions.proposed_by" }], valueKey: [{ id: "actions.proposal_id", aggregation: "count" }], legendKey: [{ id: "actions.outcome" }] },
        },
        refusals: {
          type: "bar-chart-stacked",
          format: { ...title("Why the guard said no", "Coloured by the gate that refused it."), ...legend("bottom") },
          dataMapping: { categoryKey: [{ id: "refusals.reason" }], valueKey: [{ id: "refusals.refusal_id", aggregation: "count" }], legendKey: [{ id: "refusals.stage" }] },
        },
        proposals: {
          type: "grid",
          format: title("Every proposal"),
          dataMapping: {
            cols: [
              { id: "actions.proposed_at" },
              { id: "actions.proposed_by" },
              { id: "actions.action" },
              { id: "actions.action_client" },
              { id: "actions.target" },
              { id: "actions.outcome" },
              { id: "actions.given_up" },
              { id: "actions.first_broken_rule" },
            ],
          },
        },
        invoices: {
          type: "grid",
          format: title("Invoices"),
          dataMapping: {
            cols: [
              { id: "invoices.invoice" },
              { id: "invoices.client" },
              { id: "invoices.state" },
              { id: "invoices.amount_due" },
              { id: "invoices.days_late" },
              { id: "invoices.usual_days_late" },
              { id: "invoices.collectability" },
              { id: "invoices.last_agent_action" },
            ],
          },
        },
      },
      filter: {
        page: [{ field: { id: "actions.proposed_by" } }, { field: { id: "invoices.client" } }, { field: { id: "actions.outcome" } }],
        widget: {
          age: [{ field: { id: "invoices.state" }, model: { operator: "isIn", value: ["Late", "Not due yet"] } }],
          pattern: [{ field: { id: "invoices.state" }, model: { operator: "isIn", value: ["Late", "Not due yet"] } }],
        },
      },
      widgetLayout: {
        money: { xTrack: 0, yTrack: 0, xSpan: 14, ySpan: 7 },
        agents: { xTrack: 14, yTrack: 0, xSpan: 10, ySpan: 7 },
        age: { xTrack: 0, yTrack: 7, xSpan: 8, ySpan: 17 },
        pattern: { xTrack: 8, yTrack: 7, xSpan: 8, ySpan: 17 },
        outcomes: { xTrack: 16, yTrack: 7, xSpan: 8, ySpan: 17 },
        byAgent: { xTrack: 0, yTrack: 24, xSpan: 12, ySpan: 27 },
        refusals: { xTrack: 12, yTrack: 24, xSpan: 12, ySpan: 27 },
        proposals: { xTrack: 0, yTrack: 51, xSpan: 24, ySpan: 18 },
        invoices: { xTrack: 0, yTrack: 69, xSpan: 24, ySpan: 14 },
      },
    },
  ],
} as unknown as AgReportState;
