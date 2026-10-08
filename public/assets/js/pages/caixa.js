import { requireAuth } from "../auth.js";
import { initShell, toast, modal, escapeHtml, fmtData, erroCard, tituloCard } from "../ui.js";
import { icone } from "../icons.js";
import {
  db, collection, getDocs, query, where, orderBy, limit,
  doc, addDoc, updateDoc, serverTimestamp, arrayUnion, Timestamp, writeBatch,
  inicioDoDia,
} from "../db.js";
import { brl, round2, parseNum } from "../money.js";

const FORMAS = { dinheiro: ["Dinheiro", "dinheiro"], pix: ["Pix", "pix"], debito: ["Débito", "debito"], credito: ["Crédito", "cartao"], crediario: ["Crediário", "crediario"] };
const formaHtml = (f, extra = "") => `<span style="display:inline-flex;align-items:center;gap:8px">${icone(FORMAS[f]?.[1] || "cartao", { tam: 16 })}${escapeHtml(FORMAS[f]?.[0] || f)}${extra ? ` <span class="muted">${extra}</span>` : ""}</span>`;
import { resumoCaixa } from "../crediario.js";

// Gastos sao soltos por data (nao amarrados a um caixa_id) — aqui so
// mostramos um resumo somente-leitura, pro staff ver o que ja foi lancado
// no periodo. A gestao completa (criar/editar/excluir, so admin) fica em
// /gastos. Com caixa aberto, o periodo e [aberto_em, agora]; sem caixa
// aberto, mostramos so o dia de hoje.
async function gastosDoPeriodo(inicioTs, fimTs) {
  const snap = await getDocs(query(
    collection(db, "gastos"),
    where("data", ">=", inicioTs),
    where("data", "<", fimTs),
    orderBy("data", "desc")
  ));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function gastosHtml(gastos, tituloPeriodo) {
  const total = round2(gastos.reduce((s, g) => s + (Number(g.valor) || 0), 0));
  return `
    <div class="card">
      ${tituloCard("gastos", `Gastos ${tituloPeriodo}`)}
      <div class="tabela-wrap"><table><tbody>
        ${
          gastos
            .map((g) => `<tr><td>${fmtData(g.data)}</td><td>${escapeHtml(g.descricao || "-")}</td><td class="right">${brl(g.valor)}</td></tr>`)
            .join("") || `<tr><td class="muted">Nenhum gasto lancado.</td></tr>`
        }
      </tbody></table></div>
      <p class="muted" style="margin-top:8px">Total: <strong>${brl(total)}</strong> &middot; <a href="/gastos">Gerenciar gastos</a></p>
    </div>`;
}

const { perfil } = await requireAuth();
const root = initShell({ perfil, active: "caixa" });
const ehAdm = perfil.role === "admin";

render();

// Caixa e UNICO pra loja toda, nao "do usuario logado" — antes cada conta
// (admin/vendedor) enxergava so o proprio caixa, entao dava pra duas pessoas
// abrirem caixas "paralelos" ao mesmo tempo sem perceber (dinheiro vendido
// por uma ficava fora do caixa que a outra estava fechando). Agora so pode
// haver um caixa "aberto" no sistema inteiro, e qualquer staff opera nele.
async function caixaAberto() {
  const s = (await getDocs(query(
    collection(db, "caixa"),
    where("status", "==", "aberto")
  ))).docs[0];
  return s ? { id: s.id, ...s.data() } : null;
}

async function render() {
  root.innerHTML = `<div class="card">Carregando...</div>`;
  try {
    await renderBody();
  } catch (e) {
    erroCard(root, e, render);
  }
}

async function renderBody() {
  const caixa = await caixaAberto();
  const hist = (await getDocs(query(
    collection(db, "caixa"),
    orderBy("aberto_em", "desc"),
    limit(10)
  ))).docs.map((d) => ({ id: d.id, ...d.data() }));

  if (!caixa) {
    const gastosHoje = await gastosDoPeriodo(Timestamp.fromDate(inicioDoDia()), Timestamp.now());
    root.innerHTML = `
      <div class="card">
        ${tituloCard("caixa", "Abrir o caixa", `<span class="tag fechado">fechado</span>`)}
        <p class="muted">Nenhum caixa aberto agora. Conte o dinheiro que está na gaveta pra troco e abra o caixa do dia: ele é um só pra loja toda.</p>
        <div style="max-width:320px">
          <label for="abertura">Dinheiro na gaveta (fundo de troco)</label>
          <div class="campo-rs"><input id="abertura" value="0,00" inputmode="decimal"></div>
        </div>
        <button class="btn lg" id="btn-abrir" style="margin-top:16px">${icone("caixa", { tam: 18 })}Abrir caixa</button>
      </div>
      ${gastosHtml(gastosHoje, "de hoje")}
      ${histHtml(hist)}`;
    document.getElementById("btn-abrir").onclick = async () => {
      if (await caixaAberto()) return toast("Já existe um caixa aberto. Recarregue a página.", "warn");
      await addDoc(collection(db, "caixa"), {
        data: new Date().toISOString().slice(0, 10),
        aberto_por_uid: perfil.id,
        aberto_por_nome: perfil.nome || "",
        aberto_em: serverTimestamp(),
        valor_abertura: round2(parseNum(document.getElementById("abertura").value)),
        movimentos: [],
        status: "aberto",
      });
      toast("Caixa aberto. Boas vendas!", "ok");
      render();
    };
    return;
  }

  // Sem filtro por vendedor_uid: o caixa e compartilhado, entao a
  // conferencia precisa somar as vendas de TODA a equipe que vendeu
  // enquanto esse caixa esteve aberto, nao so as do usuario logado agora.
  const vendas = (await getDocs(query(
    collection(db, "vendas"),
    where("caixa_id", "==", caixa.id)
  ))).docs
    .map((d) => d.data())
    .filter((v) => v.status === "concluida");

  // Recebimentos do crediario nesta sessao: o que o cliente pagou na hora
  // da venda (PDV) e os pagamentos lancados depois em Clientes.
  // Pagamentos ONLINE do link do crediario que chegaram com o caixa
  // fechado: este caixa (o proximo aberto) assume. Se falhar, so nao aparecem
  // agora — continuam aguardando e entram na proxima vez.
  try {
    const aguardando = await getDocs(query(
      collection(db, "crediario_pagamentos"),
      where("aguardando_caixa", "==", true)
    ));
    if (!aguardando.empty) {
      const lote = writeBatch(db);
      aguardando.docs.forEach((d) => lote.update(d.ref, { caixa_id: caixa.id, aguardando_caixa: false }));
      await lote.commit();
      toast(`${aguardando.size} pagamento(s) online do crediário entraram neste caixa.`, "info");
    }
  } catch (e) {
    console.warn("Não consegui assumir os pagamentos online pendentes:", e);
  }

  const recebimentos = (await getDocs(query(
    collection(db, "crediario_pagamentos"),
    where("caixa_id", "==", caixa.id)
  ))).docs
    .map((d) => d.data())
    .filter((r) => r.status !== "estornado");

  const gastosSessao = await gastosDoPeriodo(caixa.aberto_em, Timestamp.now());

  // Parcelado nao entra inteiro: credito entra com UMA parcela e crediario
  // so com o que foi pago (ver ../crediario.js).
  const { porForma, recebidoCrediario, totalRecebido, creditoAReceber, crediarioFiado } =
    resumoCaixa({ vendas, recebimentos });
  const movs = caixa.movimentos || [];
  const sangrias = round2(movs.filter((m) => m.tipo === "sangria").reduce((s, m) => s + m.valor, 0));
  const suprimentos = round2(movs.filter((m) => m.tipo === "suprimento").reduce((s, m) => s + m.valor, 0));
  const totalVendas = totalRecebido;
  const esperadoDinheiro = round2(
    caixa.valor_abertura + (porForma.dinheiro || 0) + (recebidoCrediario.dinheiro || 0) + suprimentos - sangrias
  );

  // "Valor liquido do caixa": vendido de TABELA (valor original, sem juros
  // do cliente) menos o custo da loja com maquininha/financiamento (ja
  // embutido em v.valor_liquido, calculado no PDV) e menos os gastos
  // lancados no periodo desta sessao. O juros cobrado do cliente no
  // parcelamento fica DE FORA do liquido — e so uma referencia informativa
  // (jurosClienteSessao), nao compensa o custo da maquininha aqui. E um
  // numero CONTABIL (nao mexe no "dinheiro esperado na gaveta" acima, que
  // continua sendo so fisico) — por isso fica num card a parte, so pro admin.
  const vendidoBruto = round2(vendas.reduce((s, v) => s + (v.total || 0), 0));
  const jurosClienteSessao = round2(
    vendas.reduce((s, v) => s + ((v.total_com_juros ?? v.total ?? 0) - (v.total || 0)), 0)
  );
  const custoLojaSessao = round2(vendas.reduce((s, v) => s + (v.custo_loja_total || 0), 0));
  const gastosSessaoTotal = round2(gastosSessao.reduce((s, g) => s + (Number(g.valor) || 0), 0));
  const valorLiquidoCaixa = round2(
    vendas.reduce((s, v) => s + (v.valor_liquido ?? v.total ?? 0), 0) - gastosSessaoTotal
  );

  root.innerHTML = `
    <div class="card">
      ${tituloCard("caixa", "Caixa do dia", `<span class="tag aberto">aberto</span>`)}
      <p class="muted" style="margin-top:-6px">Aberto em ${fmtData(caixa.aberto_em)} por ${escapeHtml(caixa.aberto_por_nome || "-")} &middot; fundo de troco ${brl(caixa.valor_abertura)}</p>
      <div class="grid cols-3">
        <div class="kpi"><div class="l">${icone("vendas", { tam: 16 })}Vendas neste caixa</div><div class="n">${vendas.length}</div></div>
        <div class="kpi"><div class="l">${icone("entrada", { tam: 16 })}Total recebido</div><div class="n">${brl(totalVendas)}</div><div class="d">todas as formas</div></div>
        <div class="kpi" style="background:var(--ouro-claro);border-color:#e6d3ac"><div class="l">${icone("dinheiro", { tam: 16 })}Dinheiro que deve estar na gaveta</div><div class="n">${brl(esperadoDinheiro)}</div><div class="d">troco + dinheiro + suprimentos − sangrias</div></div>
      </div>
      <div class="tabela-wrap" style="margin-top:16px"><table>
        <thead><tr><th>Entrou por</th><th class="right">Valor</th></tr></thead>
        <tbody>
        ${
          Object.entries(porForma)
            .map(([f, v]) => `<tr><td>${formaHtml(f, f === "credito" ? "(só a parcela do mês)" : "")}</td><td class="right">${brl(v)}</td></tr>`)
            .join("") || `<tr><td class="muted" colspan="2">Nenhuma venda neste caixa ainda.</td></tr>`
        }
        ${Object.entries(recebidoCrediario)
          .map(([f, v]) => `<tr><td>${formaHtml("crediario", `recebido em ${escapeHtml(FORMAS[f]?.[0] || f)}`)}</td><td class="right">${brl(v)}</td></tr>`)
          .join("")}
        <tr><td>${icone("entrada", { tam: 16 })} Suprimentos</td><td class="right">${brl(suprimentos)}</td></tr>
        <tr><td>${icone("saida", { tam: 16 })} Sangrias</td><td class="right">- ${brl(sangrias)}</td></tr>
        </tbody>
      </table></div>
      ${creditoAReceber || crediarioFiado ? `<p class="faixa info" style="margin-top:12px">${icone("info", { tam: 16 })}<span>Fora do caixa desta sessão:
        ${creditoAReceber ? `crédito parcelado a receber nos próximos meses <strong>${brl(creditoAReceber)}</strong>` : ""}
        ${creditoAReceber && crediarioFiado ? " &middot; " : ""}
        ${crediarioFiado ? `crediário em aberto <strong>${brl(crediarioFiado)}</strong> (ver <a href="/clientes">Clientes</a>)` : ""}</span></p>` : ""}
      <div class="row" style="margin-top:16px">
        <button class="btn ghost" id="btn-sup" title="Colocar dinheiro na gaveta">${icone("entrada", { tam: 16 })}Suprimento (colocar dinheiro)</button>
        <button class="btn ghost" id="btn-san" title="Tirar dinheiro da gaveta">${icone("saida", { tam: 16 })}Sangria (tirar dinheiro)</button>
        <button class="btn" id="btn-fechar">${icone("cadeado", { tam: 16 })}Fechar caixa</button>
      </div>
    </div>

    ${
      ehAdm
        ? `<div class="card">
      ${tituloCard("cofre", "Valor líquido do caixa")}
      <p class="muted">Vendido (valor de tabela, sem juros do cliente) menos custo de maquininha/financiamento e gastos lancados nesta sessao. Nao mexe no "dinheiro esperado na gaveta" acima, que continua sendo so o fisico.</p>
      <div class="totais"><span>Vendido (valor de tabela)</span><span>${brl(vendidoBruto)}</span></div>
      <div class="totais"><span>Custo maquininha/financiamento</span><span>- ${brl(custoLojaSessao)}</span></div>
      <div class="totais"><span>Gastos da sessao</span><span>- ${brl(gastosSessaoTotal)}</span></div>
      <div class="totais big"><span>Valor liquido</span><span>${brl(valorLiquidoCaixa)}</span></div>
      ${jurosClienteSessao ? `<p class="muted" style="margin-top:8px">Juros cobrados do cliente no parcelamento (informativo, ja fora do liquido acima): ${brl(jurosClienteSessao)}</p>` : ""}
    </div>`
        : ""
    }

    <div class="card">
      ${tituloCard("relogio", "Suprimentos e sangrias")}
      <div class="tabela-wrap"><table>
        <thead><tr><th>Quando</th><th>Quem</th><th>Tipo</th><th>Motivo</th><th class="right">Valor</th></tr></thead>
        <tbody>
          ${
            movs
              .slice()
              .reverse()
              .map(
                (m) => `<tr><td>${fmtData(m.em)}</td><td>${escapeHtml(m.nome || "-")}</td><td>${m.tipo}</td><td>${escapeHtml(m.motivo || "")}</td><td class="right">${brl(m.valor)}</td></tr>`
              )
              .join("") || `<tr><td class="muted" colspan="5">Nenhum suprimento ou sangria nesta sessão.</td></tr>`
          }
        </tbody>
      </table></div>
    </div>

    ${gastosHtml(gastosSessao, "desta sessao")}
    ${histHtml(hist)}`;

  document.getElementById("btn-sup").onclick = () => movimento("suprimento", caixa.id);
  document.getElementById("btn-san").onclick = () => movimento("sangria", caixa.id);
  document.getElementById("btn-fechar").onclick = () =>
    fechar(caixa, esperadoDinheiro, {
      porForma, recebidoCrediario, creditoAReceber, crediarioFiado, totalVendas, sangrias, suprimentos,
      valorLiquidoCaixa, custoLojaSessao, gastosSessaoTotal, jurosClienteSessao,
    });
}

function histHtml(hist) {
  return `
    <div class="card">
      ${tituloCard("calendario", "Últimos caixas")}
      <div class="tabela-wrap"><table>
        <thead><tr><th>Data</th><th>Aberto por</th><th>Abertura</th><th>Fechamento</th><th>Diferenca</th><th>Status</th></tr></thead>
        <tbody>
          ${
            hist
              .map(
                (c) => `<tr>
                  <td>${c.data || fmtData(c.aberto_em)}</td>
                  <td>${escapeHtml(c.aberto_por_nome || "-")}</td>
                  <td>${brl(c.valor_abertura)}</td>
                  <td>${c.status === "fechado" ? brl(c.valor_fechamento_informado) : "-"}</td>
                  <td>${c.status === "fechado" ? brl(c.resumo?.diferenca || 0) : "-"}</td>
                  <td><span class="tag ${c.status === "aberto" ? "ativo" : "descontinuado"}">${c.status}</span></td>
                </tr>`
              )
              .join("") || `<tr><td class="muted">-</td></tr>`
          }
        </tbody>
      </table></div>
    </div>`;
}

function movimento(tipo, caixaId) {
  const c = document.createElement("div");
  c.innerHTML = `
    <p class="muted">${tipo === "sangria" ? "Dinheiro que SAI da gaveta (ex.: pagar fornecedor, levar ao banco)." : "Dinheiro que ENTRA na gaveta sem ser venda (ex.: reforço de troco)."}</p>
    <label for="mv">Valor</label><div class="campo-rs"><input id="mv" inputmode="decimal" value="0,00"></div>
    <label for="mm">Motivo</label><input id="mm" placeholder="Ex.: troco, pagamento fornecedor">`;
  modal({
    titulo: tipo === "sangria" ? "Registrar sangria" : "Registrar suprimento",
    corpo: c,
    onConfirmar: async () => {
      const valor = round2(parseNum(c.querySelector("#mv").value));
      if (valor <= 0) {
        toast("Informe um valor maior que zero.", "err");
        return false;
      }
      await updateDoc(doc(db, "caixa", caixaId), {
        movimentos: arrayUnion({
          tipo,
          valor,
          motivo: c.querySelector("#mm").value.trim(),
          uid: perfil.id,
          nome: perfil.nome || "",
          em: Timestamp.now(),
        }),
      });
      toast(tipo === "sangria" ? "Sangria registrada." : "Suprimento registrado.", "ok");
      render();
    },
  });
}

function fechar(caixa, esperadoDinheiro, parcial) {
  const c = document.createElement("div");
  c.innerHTML = `
    <div class="kpi" style="background:var(--ouro-claro);border:1px solid #e6d3ac;border-radius:var(--r-sm);padding:12px 16px">
      <div class="l" style="min-height:0">${icone("dinheiro", { tam: 16 })}Deveria ter na gaveta</div><div class="n">${brl(esperadoDinheiro)}</div>
    </div>
    <label for="contado">Quanto você contou em dinheiro?</label>
    <div class="campo-rs"><input id="contado" inputmode="decimal" value="0,00"></div>
    <p class="dica">Conte cédulas e moedas. A diferença fica registrada no histórico.</p>`;
  modal({
    titulo: "Fechar caixa",
    corpo: c,
    textoConfirmar: "Fechar",
    onConfirmar: async () => {
      const informado = round2(parseNum(c.querySelector("#contado").value));
      const diferenca = round2(informado - esperadoDinheiro);
      await updateDoc(doc(db, "caixa", caixa.id), {
        status: "fechado",
        fechado_por_uid: perfil.id,
        fechado_por_nome: perfil.nome || "",
        fechado_em: serverTimestamp(),
        valor_fechamento_informado: informado,
        resumo: {
          por_forma: parcial.porForma,
          recebido_crediario: parcial.recebidoCrediario,
          credito_a_receber: parcial.creditoAReceber,
          crediario_fiado: parcial.crediarioFiado,
          total_vendas: parcial.totalVendas,
          sangrias: parcial.sangrias,
          suprimentos: parcial.suprimentos,
          saldo_esperado_dinheiro: esperadoDinheiro,
          diferenca,
          valor_liquido_caixa: parcial.valorLiquidoCaixa,
          custo_loja_sessao: parcial.custoLojaSessao,
          gastos_sessao: parcial.gastosSessaoTotal,
          juros_cliente_sessao: parcial.jurosClienteSessao,
        },
      });
      toast(diferenca === 0 ? "Caixa fechado. Bateu certinho." : `Caixa fechado com diferença de ${brl(diferenca)}.`, diferenca === 0 ? "ok" : "warn");
      render();
    },
  });
}
