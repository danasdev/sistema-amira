import { requireAuth } from "../auth.js";
import { initShell, toast, modal, escapeHtml, fmtData, erroCard } from "../ui.js";
import {
  db, collection, getDocs, query, where, orderBy, limit,
  doc, addDoc, updateDoc, serverTimestamp, arrayUnion, Timestamp,
  inicioDoDia,
} from "../db.js";
import { brl, round2, parseNum } from "../money.js";
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
      <strong>Gastos ${tituloPeriodo}</strong>
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
        <strong>Abrir caixa</strong>
        <p class="muted">Nao ha caixa aberto no momento.</p>
        <label>Valor de abertura (fundo de troco)</label>
        <input id="abertura" value="0" inputmode="decimal">
        <button class="btn" id="btn-abrir" style="margin-top:12px">Abrir caixa</button>
      </div>
      ${gastosHtml(gastosHoje, "de hoje")}
      ${histHtml(hist)}`;
    document.getElementById("btn-abrir").onclick = async () => {
      if (await caixaAberto()) return toast("Ja existe um caixa aberto.", "warn");
      await addDoc(collection(db, "caixa"), {
        data: new Date().toISOString().slice(0, 10),
        aberto_por_uid: perfil.id,
        aberto_por_nome: perfil.nome || "",
        aberto_em: serverTimestamp(),
        valor_abertura: round2(parseNum(document.getElementById("abertura").value)),
        movimentos: [],
        status: "aberto",
      });
      toast("Caixa aberto.", "ok");
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
      <strong>Caixa aberto</strong>
      <p class="muted">Aberto em ${fmtData(caixa.aberto_em)} por ${escapeHtml(caixa.aberto_por_nome || "-")} &middot; abertura ${brl(caixa.valor_abertura)}</p>
      <div class="grid cols-3">
        <div class="kpi"><div class="l">Vendas no caixa</div><div class="n">${vendas.length}</div></div>
        <div class="kpi"><div class="l">Total recebido</div><div class="n">${brl(totalVendas)}</div></div>
        <div class="kpi"><div class="l">Dinheiro esperado</div><div class="n">${brl(esperadoDinheiro)}</div></div>
      </div>
      <table style="margin-top:12px"><tbody>
        ${
          Object.entries(porForma)
            .map(([f, v]) => `<tr><td>${f === "credito" ? "credito (parcela do mes)" : f}</td><td class="right">${brl(v)}</td></tr>`)
            .join("") || `<tr><td class="muted">Sem vendas ainda.</td></tr>`
        }
        ${Object.entries(recebidoCrediario)
          .map(([f, v]) => `<tr><td>crediario recebido (${f})</td><td class="right">${brl(v)}</td></tr>`)
          .join("")}
        <tr><td>Suprimentos</td><td class="right">${brl(suprimentos)}</td></tr>
        <tr><td>Sangrias</td><td class="right">- ${brl(sangrias)}</td></tr>
      </tbody></table>
      ${creditoAReceber || crediarioFiado ? `<p class="muted" style="margin-top:8px">Fora do caixa desta sessao:
        ${creditoAReceber ? `credito parcelado a receber nos proximos meses <strong>${brl(creditoAReceber)}</strong>` : ""}
        ${creditoAReceber && crediarioFiado ? " &middot; " : ""}
        ${crediarioFiado ? `crediario em aberto <strong>${brl(crediarioFiado)}</strong> (ver <a href="/clientes">Clientes</a>)` : ""}</p>` : ""}
      <div class="row" style="margin-top:12px">
        <button class="btn ghost" id="btn-sup">Suprimento</button>
        <button class="btn ghost" id="btn-san">Sangria</button>
        <button class="btn" id="btn-fechar">Fechar caixa</button>
      </div>
    </div>

    ${
      ehAdm
        ? `<div class="card">
      <strong>Valor liquido do caixa</strong>
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
      <strong>Movimentos</strong>
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
              .join("") || `<tr><td class="muted">-</td></tr>`
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
      <strong>Historico (ultimos caixas)</strong>
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
    <label>Valor</label><input id="mv" inputmode="decimal" value="0">
    <label>Motivo</label><input id="mm" placeholder="Ex.: troco, pagamento fornecedor">`;
  modal({
    titulo: tipo === "sangria" ? "Registrar sangria" : "Registrar suprimento",
    corpo: c,
    onConfirmar: async () => {
      const valor = round2(parseNum(c.querySelector("#mv").value));
      if (valor <= 0) {
        toast("Valor invalido.", "err");
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
      toast("Movimento registrado.", "ok");
      render();
    },
  });
}

function fechar(caixa, esperadoDinheiro, parcial) {
  const c = document.createElement("div");
  c.innerHTML = `
    <p>Dinheiro esperado na gaveta: <strong>${brl(esperadoDinheiro)}</strong></p>
    <label>Valor contado em dinheiro</label>
    <input id="contado" inputmode="decimal" value="0">`;
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
      toast(`Caixa fechado. Diferenca: ${brl(diferenca)}`, diferenca === 0 ? "ok" : "warn");
      render();
    },
  });
}
