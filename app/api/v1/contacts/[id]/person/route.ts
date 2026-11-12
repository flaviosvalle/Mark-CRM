import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { linkContactToPersonHandler } from "@/lib/crm-b2b/people-handler";
import {
  autorizarEscritaB2b,
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  person_id: z.string().uuid().nullable(),
});

/** PATCH /api/v1/contacts/:id/person — associa contact a people (same org). */
export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await autorizarEscritaB2b(req, requestId, { resource: "contacts", role: "agent" });
  if (!authz.ok) return authz.response;
  const { supabase, ctx, autor } = authz;
  const { id } = await params;

  try {
    const body = bodySchema.parse(await req.json());
    const data = await linkContactToPersonHandler(supabase, ctx, autor, id, body.person_id);
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
