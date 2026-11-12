/**
 * Contato por integração (`crm:write`): criar, editar (inclusive `tags`) e
 * bloquear, por sessão OU Bearer.
 *
 * O que não pode regredir:
 *  1. Org da LINHA DO TOKEN; o ator do token é `api_token`, não um usuário.
 *  2. `mcp:write` sozinho não escreve cadastro (403).
 *  3. Criar pela sessão continua a levar o PAPEL no ator ("Só os seus").
 *  4. O bloqueio é idempotente: já bloqueado → 200, sem regravar o motivo
 *     original e sem nova linha de audit; contato de outra org → 404.
 *  5. `unblock` continua fora de `public-paths` (o token não reabre canal).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(), orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/legal/perfil-do-pais", async () => {
  const actual = await vi.importActual<typeof import("@/lib/legal/perfil-do-pais")>(
    "@/lib/legal/perfil-do-pais",
  );
  return { ...actual, perfilDaOrganizacao: vi.fn(async () => actual.perfilDoPais("PT")) };
});
vi.mock("./_handler", () => ({
  createContactHandler: vi.fn(async () => ({ id: "novo" })),
  patchContactHandler: vi.fn(async () => ({ id: "editado" })),
  listContactsHandler: vi.fn(),
  getContactHandler: vi.fn(),
  deleteContactHandler: vi.fn(),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { createClient } = await import("@/lib/supabase/server");
const { requireRole } = await import("@/lib/auth/require-role");
const { audit } = await import("@/lib/audit");
const { isPublicPath } = await import("@/lib/auth/public-paths");
const { createContactHandler, patchContactHandler } = await import("./_handler");
const { POST: criar } = await import("./route");
const { PATCH: editar } = await import("./[id]/route");
const { POST: bloquear } = await import("./[id]/block/route");

const ORG_DO_TOKEN = "22222222-2222-4222-8222-222222222222";
const ORG_DA_SESSAO = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN_ID = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";

function token(scopes: string[]): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_DO_TOKEN,
    scopes,
    role: "agent",
    actor: { type: "api_token", id: TOKEN_ID, role: "agent" },
    apiTokenId: TOKEN_ID,
  } as never);
}

function pedido(url: string, metodo: string, corpo?: unknown, bearer = true) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = "Bearer dsk_abc";
  return new NextRequest(`http://localhost${url}`, {
    method: metodo,
    headers,
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
}

const params = { params: Promise.resolve({ id: CONTATO }) };

/** Banco falso do bloqueio: `update ... eq(is_blocked,false)` e a releitura. */
function bancoDoBloqueio(estado: { existe: boolean; bloqueado: boolean; motivo: string | null }) {
  const filtros: Array<[string, unknown]> = [];
  const linha = () => ({
    id: CONTATO,
    is_blocked: estado.bloqueado,
    blocked_reason: estado.motivo,
  });
  const banco = {
    from: () => ({
      update: (dados: Record<string, unknown>) => {
        const q = {
          eq: (c: string, v: unknown) => {
            filtros.push([c, v]);
            return q;
          },
          select: () => ({
            maybeSingle: async () => {
              const daOrg = filtros.some(([c, v]) => c === "organization_id" && v === ORG_DO_TOKEN);
              if (!estado.existe || !daOrg || estado.bloqueado) return { data: null, error: null };
              estado.bloqueado = true;
              estado.motivo = dados.blocked_reason as string;
              return { data: linha(), error: null };
            },
          }),
        };
        return q;
      },
      select: () => {
        const q = {
          eq: () => q,
          maybeSingle: async () => ({ data: estado.existe ? linha() : null, error: null }),
        };
        return q;
      },
    }),
  };
  return { banco, filtros };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue({ admin: true } as never);
});

describe("POST /api/v1/contacts por token", () => {
  it("crm:write cria com a org e o ator do token", async () => {
    token(["crm:write"]);
    const res = await criar(
      pedido("/api/v1/contacts", "POST", { name: "Rui", phone_number: "+351912345678" }),
    );
    expect(res.status).toBe(201);
    const [, ctx] = vi.mocked(createContactHandler).mock.calls[0]!;
    expect(ctx.organization_id).toBe(ORG_DO_TOKEN);
    expect(ctx.actor).toMatchObject({ type: "api_token", id: TOKEN_ID });
  });

  it("mcp:write sem crm:write é recusado com 403", async () => {
    token(["mcp:read", "mcp:write"]);
    const res = await criar(pedido("/api/v1/contacts", "POST", { name: "Rui" }));
    expect(res.status).toBe(403);
    expect(createContactHandler).not.toHaveBeenCalled();
  });

  it("pela sessão, o ator continua a levar o papel (Só os seus)", async () => {
    vi.mocked(createClient).mockResolvedValue({ session: true } as never);
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER_ID, idioma: "pt-BR" },
      org: { orgId: ORG_DA_SESSAO, role: "agent" },
    } as never);
    const res = await criar(pedido("/api/v1/contacts", "POST", { name: "Rui" }, false));
    expect(res.status).toBe(201);
    const [, ctx] = vi.mocked(createContactHandler).mock.calls[0]!;
    expect(ctx.organization_id).toBe(ORG_DA_SESSAO);
    expect(ctx.actor).toEqual({ type: "user", id: USER_ID, role: "agent" });
  });
});

describe("PATCH /api/v1/contacts/:id por token", () => {
  it("crm:write edita tags com a org do token", async () => {
    token(["crm:write"]);
    const res = await editar(
      pedido(`/api/v1/contacts/${CONTATO}`, "PATCH", { tags: ["ephata-b2b"] }),
      params,
    );
    expect(res.status).toBe(200);
    const [, ctx, id, input] = vi.mocked(patchContactHandler).mock.calls[0]!;
    expect(ctx.organization_id).toBe(ORG_DO_TOKEN);
    expect(ctx.actor).toMatchObject({ type: "api_token" });
    expect(id).toBe(CONTATO);
    expect(input).toMatchObject({ tags: ["ephata-b2b"] });
  });

  it("o corpo não desbloqueia: is_blocked não passa pelo esquema", async () => {
    token(["crm:write"]);
    await editar(
      pedido(`/api/v1/contacts/${CONTATO}`, "PATCH", { is_blocked: false, tags: [] }),
      params,
    );
    const input = vi.mocked(patchContactHandler).mock.calls[0]?.[3] as
      Record<string, unknown> | undefined;
    expect(input && "is_blocked" in input).toBeFalsy();
  });
});

describe("POST /api/v1/contacts/:id/block", () => {
  it("bloqueia com motivo padrão `api` e audita pelo token", async () => {
    token(["crm:write"]);
    const { banco } = bancoDoBloqueio({ existe: true, bloqueado: false, motivo: null });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);
    const res = await bloquear(pedido(`/api/v1/contacts/${CONTATO}/block`, "POST"), params);
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.data).toMatchObject({ is_blocked: true, blocked_reason: "api" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.blocked",
        actorUserId: null,
        actorApiTokenId: TOKEN_ID,
        organizationId: ORG_DO_TOKEN,
      }),
    );
  });

  it("já bloqueado: 200, mantém o motivo original e não audita de novo", async () => {
    token(["crm:write"]);
    const { banco } = bancoDoBloqueio({ existe: true, bloqueado: true, motivo: "stop_keyword" });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);
    const res = await bloquear(
      pedido(`/api/v1/contacts/${CONTATO}/block`, "POST", { reason: "ephata_site" }),
      params,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      is_blocked: true,
      blocked_reason: "stop_keyword",
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("contato inexistente na org do token: 404", async () => {
    token(["crm:write"]);
    const { banco } = bancoDoBloqueio({ existe: false, bloqueado: false, motivo: null });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);
    const res = await bloquear(pedido(`/api/v1/contacts/${CONTATO}/block`, "POST"), params);
    expect(res.status).toBe(404);
  });

  it("filtra pela org do token e só regrava quem não está bloqueado", async () => {
    token(["crm:write"]);
    const { banco, filtros } = bancoDoBloqueio({ existe: true, bloqueado: false, motivo: null });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);
    await bloquear(pedido(`/api/v1/contacts/${CONTATO}/block`, "POST"), params);
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG_DO_TOKEN],
        ["id", CONTATO],
        ["is_blocked", false],
      ]),
    );
  });

  it("motivo fora do formato é recusado com 422", async () => {
    token(["crm:write"]);
    const res = await bloquear(
      pedido(`/api/v1/contacts/${CONTATO}/block`, "POST", { reason: "Pediu Por E-mail!" }),
      params,
    );
    expect(res.status).toBe(422);
  });

  it("mcp:write sem crm:write é recusado com 403", async () => {
    token(["mcp:read", "mcp:write"]);
    const res = await bloquear(pedido(`/api/v1/contacts/${CONTATO}/block`, "POST"), params);
    expect(res.status).toBe(403);
  });
});

describe("borda do proxy", () => {
  it("libera PATCH do contato e o bloqueio; unblock continua fechado", () => {
    expect(isPublicPath(`/api/v1/contacts/${CONTATO}`)).toBe(true);
    expect(isPublicPath(`/api/v1/contacts/${CONTATO}/block`)).toBe(true);
    expect(isPublicPath(`/api/v1/contacts/${CONTATO}/unblock`)).toBe(false);
    expect(isPublicPath(`/api/v1/contacts/${CONTATO}/block/extra`)).toBe(false);
  });
});
