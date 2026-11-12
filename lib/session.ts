import { cookies } from "next/headers";
import { OPERATOR_COOKIE, operatorFromCookie } from "./guard";

export async function operator() {
  const jar = await cookies();
  return operatorFromCookie(jar.get(OPERATOR_COOKIE)?.value);
}
