import { type NextRequest } from "next/server";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { patchCompanyPersonHandler } from "@/lib/crm-b2b/people-handler";
import {
  autorizarEscritaB2b,
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await autorizarEscritaB2b(req, requestId, {
    resource: "company_people",
    role: "agent",
  });
  if (!authz.ok) return authz.response;
  const { supabase, ctx, autor } = authz;
  const { id } = await params;

  try {
    const body = await req.json();
    const data = await patchCompanyPersonHandler(supabase, ctx, autor, id, body);
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
