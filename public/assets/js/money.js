export const round2 = (n) => Math.round((Number(n) || 0) * 100 + Number.EPSILON) / 100;

export const brl = (n) =>
  (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Aceita "1234.56", "1.234,56", "R$ 1.234,56" -> number
export function parseNum(v) {
  if (typeof v === "number") return v;
  if (v == null || v === "") return 0;
  let s = String(v).trim();
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  return Number(s.replace(/[^\d.\-]/g, "")) || 0;
}

// Valor pra preencher um <input> no formato brasileiro: 419.7 -> "419,70".
export const valorCampo = (n) => (Number(n) || 0).toFixed(2).replace(".", ",");
