import Cockpit from "./cockpit";
import { operator } from "@/lib/session";
import { snapshot } from "@/lib/state";

export const dynamic = "force-dynamic";

export default async function Page() {
  const initial = await snapshot(await operator());
  return <Cockpit initial={JSON.parse(JSON.stringify(initial))} />;
}
