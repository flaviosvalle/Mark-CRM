import { type NextRequest } from "next/server";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { linkCompanyPersonHandler } from "@/lib/crm-b2b/people-handler";
import {
  autorizarEscritaB2b,
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await autorizarEscritaB2b(req, requestId, {
    resource: "company_people",
    role: "manager",
  });
  if (!authz.ok) return authz.response;
  const { supabase, ctx, autor } = authz;

  try {
    const body = await req.json();
    const data = await linkCompanyPersonHandler(supabase, ctx, autor, body);
    return ok(data, { requestId, status: 201 });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
