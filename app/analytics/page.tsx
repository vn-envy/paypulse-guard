import { llmConfig } from "@/lib/agent";
import { analyticsData } from "@/lib/analytics";
import Analytics from "./analytics";

export const dynamic = "force-dynamic";

export default async function Page() {
  const data = await analyticsData();
  // AG Studio licence keys are designed to ship to the browser. Without one, Studio shows a watermark.
  // The assistant panel only appears when the server has an LLM key to answer with.
  return <Analytics initial={JSON.parse(JSON.stringify(data))} licenseKey={process.env.AG_STUDIO_LICENSE_KEY ?? ""} ai={llmConfig().enabled} />;
}
