/**
 * Helpers de rota para CRM B2B — Zod + ApiError → fail().
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";

import { ESCOPO_ESCRITA_CRM, resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import type { Role } from "@/lib/auth/types";
import type { Autoria } from "@/lib/crm-b2b/autoria";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { RoleCheck } from "@/lib/auth/require-role";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Empresas, pessoas e importação são MÓDULO OPCIONAL da instalação, desligado
 * por padrão (doc 68, `lib/instalacao/modulos.ts`). Desligado, nenhuma rota
 * dele existe: 404, a mesma resposta de uma rota nunca instalada — e a mesma de
 * `notFound()` na tela. Toda rota do módulo chama isto primeiro, como as de
 * `/api/v1/external-db`.
 */
export async function seModuloB2bDesligado(requestId: string): Promise<Response | null> {
  if (await moduloLigado(createAdminClient(), "crm_b2b")) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}

export function requestIdOf(req: Request): string {
  return req.headers.get("x-request-id") ?? randomUUID();
}

export function ctxFromAuthz(authz: Extract<RoleCheck, { ok: true }>, requestId: string): HandlerCtx {
  return {
    organization_id: authz.org.orgId,
    actor: { type: "user", id: authz.user.id, role: authz.org.role },
    requestId,
    idioma: authz.user.idioma,
  };
}

export type EscritaB2b =
  | { ok: true; supabase: SupabaseClient; ctx: HandlerCtx; autor: Autoria }
  | { ok: false; response: Response };

/**
 * Escrita no cadastro B2B por SESSÃO ou por TOKEN com `crm:write`.
 *
 * - Sessão: o mesmo `requireRole(role)` de antes, cliente com RLS.
 * - Token: `resolveAuthDual` (org da LINHA DO TOKEN, nunca do corpo), escopo
 *   `crm:write` e o mesmo rank mínimo da sessão (o token precisa de
 *   `role:manager` para criar). Cliente de serviço; todo handler do módulo já
 *   filtra por `organization_id`. Teto de escrita por token e por org.
 *
 * O `proxy.ts` só deixa um Bearer chegar aqui se o caminho estiver em
 * `lib/auth/public-paths.ts`.
 */
export async function autorizarEscritaB2b(
  req: NextRequest,
  requestId: string,
  opts: { resource: string; role: Role },
): Promise<EscritaB2b> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: opts.resource,
    role: opts.role,
    scope: ESCOPO_ESCRITA_CRM,
  });
  if (!authz.ok) return authz;

  const teto = await tetoDeEscritaDoToken(authz, "crm_b2b", requestId);
  if (teto) return { ok: false, response: teto };

  const autor: Autoria =
    authz.via === "token"
      ? { userId: null, apiTokenId: authz.apiTokenId ?? authz.actor.id }
      : { userId: authz.actor.id, apiTokenId: null };

  return {
    ok: true,
    supabase: authz.supabase,
    ctx: {
      organization_id: authz.organizationId,
      actor: authz.actor,
      requestId,
      idioma: authz.idioma,
    },
    autor,
  };
}

export function handleRouteError(err: unknown, requestId: string): Response {
  if (err instanceof ApiError) {
    return fail(err.code, err.message, err.status, { requestId, details: err.details });
  }
  if (err instanceof ZodError) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: { issues: err.issues },
    });
  }
  const message = err instanceof Error ? err.message : "Erro interno.";
  return fail("internal_error", message, 500, { requestId });
}

export { ok, fail };
