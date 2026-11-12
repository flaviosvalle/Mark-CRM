/**
 * Identificador fiscal genérico da empresa (`tax_id` + `tax_id_country`).
 *
 * O que estes testes fixam:
 *  1. PT valida NIF/NIPC pelo mod-11 da AT; BR é recusado (o CNPJ tem coluna
 *     própria); outros países aceitam letras e dígitos sem checksum inventado.
 *  2. Criar e editar gravam o par normalizado; documento sem país é 422; o par
 *     repetido na mesma org é 409; `tax_id` vazio limpa os dois.
 *  3. Enriquecer empresa sem CNPJ é recusado (422) ANTES de a BrasilAPI ser
 *     chamada — senão ela ficaria `failed` por "CNPJ inválido".
 *  4. A migration e o baseline trazem as mesmas colunas, checagens e índice.
 */
import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/crm-b2b/enrich", () => ({
  enrichCompanyFromBrasilApi: vi.fn(async () => ({ status: "completed" })),
}));

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import {
  createCompanyHandler,
  enrichCompanyHandler,
  patchCompanyHandler,
} from "@/lib/crm-b2b/companies-handler";
import { enrichCompanyFromBrasilApi } from "@/lib/crm-b2b/enrich";
import { validarIdentificadorFiscal } from "@/lib/legal/perfil-do-pais";

const ORG = "11111111-1111-4111-8111-111111111111";
const EMPRESA = "22222222-2222-4222-8222-222222222222";
const ATOR = "33333333-3333-4333-8333-333333333333";
const CTX: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: ATOR, role: "manager" },
  requestId: "req-fiscal",
  idioma: "pt-BR",
};
const NIPC_VALIDO = "501964843";

async function erroDe(p: Promise<unknown>): Promise<ApiError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

/** Banco falso: `select` devolve `existente` quando a consulta filtra por tax_id. */
function banco(opts: { existenteFiscal?: boolean; linha?: Record<string, unknown> } = {}) {
  const insercoes: Array<Record<string, unknown>> = [];
  const atualizacoes: Array<Record<string, unknown>> = [];
  const b = {
    from: (tabela: string) => ({
      select: () => {
        const filtros: string[] = [];
        const q = {
          eq: (c: string) => {
            filtros.push(c);
            return q;
          },
          maybeSingle: async () => {
            if (tabela === "companies" && filtros.includes("tax_id")) {
              return { data: opts.existenteFiscal ? { id: "outra" } : null, error: null };
            }
            if (tabela === "companies" && filtros.includes("id")) {
              return { data: { id: EMPRESA, ...(opts.linha ?? {}) }, error: null };
            }
            return { data: null, error: null };
          },
          then: (r: (v: { data: unknown[]; error: null }) => unknown) =>
            r({ data: [], error: null }),
        };
        return q;
      },
      insert: (dados: Record<string, unknown>) => {
        insercoes.push(dados);
        return {
          select: () => ({
            single: async () => ({ data: { id: EMPRESA, ...dados }, error: null }),
          }),
        };
      },
      update: (dados: Record<string, unknown>) => {
        atualizacoes.push(dados);
        const q = {
          eq: () => q,
          select: () => ({
            maybeSingle: async () => ({ data: { id: EMPRESA, ...dados }, error: null }),
          }),
        };
        return q;
      },
    }),
  };
  return { banco: b as unknown as SupabaseClient, insercoes, atualizacoes };
}

beforeEach(() => vi.clearAllMocks());

describe("validarIdentificadorFiscal", () => {
  it("PT aceita NIPC válido e normaliza espaços, pontos e traços", () => {
    expect(validarIdentificadorFiscal("pt", "501 964.843")).toEqual({
      ok: true,
      pais: "PT",
      valor: NIPC_VALIDO,
    });
  });

  it.each(["501964842", "12345678", "111111111"])("PT recusa %s", (v) => {
    expect(validarIdentificadorFiscal("PT", v).ok).toBe(false);
  });

  it("BR é recusado: o CNPJ tem coluna própria", () => {
    const r = validarIdentificadorFiscal("BR", "11222333000181");
    expect(r).toEqual({ ok: false, mensagem: "Para empresa brasileira, use o campo CNPJ." });
  });

  it("outro país aceita letras e dígitos sem checksum", () => {
    expect(validarIdentificadorFiscal("ES", "b-12345678")).toEqual({
      ok: true,
      pais: "ES",
      valor: "B12345678",
    });
  });

  it.each([
    [null, NIPC_VALIDO],
    ["Portugal", NIPC_VALIDO],
    ["PT", "50196!4843"],
    ["ES", "X".repeat(33)],
  ])("recusa país %s com documento %s", (pais, valor) => {
    expect(validarIdentificadorFiscal(pais, valor).ok).toBe(false);
  });
});

describe("criar e editar empresa com tax_id", () => {
  it("criar grava o par normalizado", async () => {
    const { banco: b, insercoes } = banco();
    await createCompanyHandler(b, CTX, ATOR, {
      legal_name: "Hotel Sol, Lda.",
      tax_id: "501 964 843",
      tax_id_country: "pt",
      enrich: false,
    });
    expect(insercoes[0]).toMatchObject({ tax_id: NIPC_VALIDO, tax_id_country: "PT", cnpj: null });
  });

  it("documento sem país é 422", async () => {
    const { banco: b } = banco();
    const e = await erroDe(
      createCompanyHandler(b, CTX, ATOR, { legal_name: "X", tax_id: NIPC_VALIDO }),
    );
    expect(e.status).toBe(422);
  });

  it("NIF com dígito errado é 422 com mensagem que diz o que conferir", async () => {
    const { banco: b } = banco();
    const e = await erroDe(
      createCompanyHandler(b, CTX, ATOR, {
        legal_name: "X",
        tax_id: "501964842",
        tax_id_country: "PT",
      }),
    );
    expect(e.status).toBe(422);
    expect(e.message).toContain("NIF/NIPC");
  });

  it("par repetido na mesma org é 409", async () => {
    const { banco: b, insercoes } = banco({ existenteFiscal: true });
    const e = await erroDe(
      createCompanyHandler(b, CTX, ATOR, {
        legal_name: "X",
        tax_id: NIPC_VALIDO,
        tax_id_country: "PT",
      }),
    );
    expect(e.status).toBe(409);
    expect(insercoes).toHaveLength(0);
  });

  it("editar com tax_id vazio limpa os dois", async () => {
    const { banco: b, atualizacoes } = banco();
    await patchCompanyHandler(b, CTX, ATOR, EMPRESA, { tax_id: "" });
    expect(atualizacoes[0]).toMatchObject({ tax_id: null, tax_id_country: null });
  });

  it("editar só o país, sem o documento, é 422", async () => {
    const { banco: b } = banco();
    const e = await erroDe(patchCompanyHandler(b, CTX, ATOR, EMPRESA, { tax_id_country: "PT" }));
    expect(e.status).toBe(422);
  });

  it("editar sem tocar no par não o grava", async () => {
    const { banco: b, atualizacoes } = banco();
    await patchCompanyHandler(b, CTX, ATOR, EMPRESA, { trade_name: "Sol" });
    expect(atualizacoes[0]).not.toHaveProperty("tax_id");
    expect(atualizacoes[0]).not.toHaveProperty("tax_id_country");
  });
});

describe("enriquecimento só com CNPJ", () => {
  it("empresa sem CNPJ: 422 e a BrasilAPI não é chamada", async () => {
    const { banco: b } = banco({
      linha: { normalized_cnpj: null, tax_id: NIPC_VALIDO, tax_id_country: "PT" },
    });
    const e = await erroDe(enrichCompanyHandler(b, CTX, ATOR, EMPRESA));
    expect(e.status).toBe(422);
    expect(e.code).toBe("enrichment_unavailable");
    expect(enrichCompanyFromBrasilApi).not.toHaveBeenCalled();
  });

  it("empresa com CNPJ continua a enriquecer", async () => {
    const { banco: b } = banco({ linha: { normalized_cnpj: "11222333000181" } });
    await enrichCompanyHandler(b, CTX, ATOR, EMPRESA);
    expect(enrichCompanyFromBrasilApi).toHaveBeenCalledTimes(1);
  });
});

describe("migration 9348 e baseline", () => {
  const migration = readFileSync(
    "supabase/migrations/20261112120000_9348_identificador_fiscal_da_empresa.sql",
    "utf8",
  );
  const baseline = readFileSync("supabase/baseline.sql", "utf8");
  const bloco = baseline.slice(
    baseline.indexOf("-- ---- identificador fiscal genérico da empresa (migration 9348)"),
  );

  it.each([
    "add column if not exists tax_id text",
    "add column if not exists tax_id_country text",
    "companies_tax_id_country_iso",
    "companies_tax_id_com_pais",
    "create unique index if not exists companies_org_tax_id_uidx",
  ])("as duas trazem %s", (trecho) => {
    expect(migration).toContain(trecho);
    expect(bloco).toContain(trecho);
  });
});
