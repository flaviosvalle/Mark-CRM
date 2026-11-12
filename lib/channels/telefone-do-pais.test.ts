/**
 * Telefone sem `+` pela régua do país da organização (`normalizePhoneDoPais`).
 *
 * O defeito: `normalizePhoneBR` punha `+55` em 10–11 dígitos sem `+`. Numa
 * organização de Portugal, `912345678` (9 dígitos) era recusado e um número de
 * 10–11 dígitos mal digitado virava telefone brasileiro — mensagem para outra
 * pessoa noutro país.
 *
 * O que fica fixo:
 *  1. Brasil (ou coluna vazia) continua EXATAMENTE como `normalizePhoneBR`.
 *  2. PT: 9 dígitos com 2/9 ganham `+351`; nada vira `+55`.
 *  3. País sem régua local: só o internacional (`+`/`00`) passa.
 *  4. O webhook de captação usa o país da organização.
 */
import { describe, expect, it } from "vitest";

import { normalizePhoneBR, normalizePhoneDoPais } from "@/lib/channels/phone-variants";
import { mapInboundPayload } from "@/lib/webhooks/inbound";

describe("normalizePhoneDoPais", () => {
  it.each(["11987654321", "(11) 98765-4321", "+5511987654321", "5511987654321", "123"])(
    "Brasil e coluna vazia seguem normalizePhoneBR para %s",
    (raw) => {
      expect(normalizePhoneDoPais(raw, "BR")).toBe(normalizePhoneBR(raw));
      expect(normalizePhoneDoPais(raw, null)).toBe(normalizePhoneBR(raw));
      expect(normalizePhoneDoPais(raw, "")).toBe(normalizePhoneBR(raw));
    },
  );

  it.each([
    ["912345678", "+351912345678"],
    ["912 345 678", "+351912345678"],
    ["213456789", "+351213456789"],
    ["351912345678", "+351912345678"],
    ["+351 912 345 678", "+351912345678"],
    ["00351912345678", "+351912345678"],
    ["+5511987654321", "+5511987654321"],
  ])("PT: %s → %s", (raw, esperado) => {
    expect(normalizePhoneDoPais(raw, "PT")).toBe(esperado);
  });

  it.each(["11987654321", "1198765432", "812345678", "12345"])(
    "PT: %s sem indicativo não vira +55 (fica sem telefone)",
    (raw) => {
      expect(normalizePhoneDoPais(raw, "pt")).toBeNull();
    },
  );

  it("país sem régua local só aceita o internacional", () => {
    expect(normalizePhoneDoPais("612345678", "ES")).toBeNull();
    expect(normalizePhoneDoPais("+34 612 345 678", "ES")).toBe("+34612345678");
    expect(normalizePhoneDoPais("0034612345678", "ES")).toBe("+34612345678");
  });

  it("vazio e não-texto continuam null", () => {
    expect(normalizePhoneDoPais("", "PT")).toBeNull();
    expect(normalizePhoneDoPais(912345678, "PT")).toBeNull();
    expect(normalizePhoneDoPais(undefined, "PT")).toBeNull();
  });
});

describe("mapInboundPayload com o país da organização", () => {
  it("organização PT: 912345678 vira +351", () => {
    expect(mapInboundPayload({ name: "Rui", phone: "912345678" }, {}, "PT").phone).toBe(
      "+351912345678",
    );
  });

  it("organização PT: 11 dígitos sem + não viram número brasileiro", () => {
    expect(mapInboundPayload({ name: "Rui", phone: "11987654321" }, {}, "PT").phone).toBeNull();
  });

  it("sem país (padrão) continua a régua brasileira", () => {
    expect(mapInboundPayload({ name: "Ana", phone: "11987654321" }).phone).toBe("+5511987654321");
  });
});
