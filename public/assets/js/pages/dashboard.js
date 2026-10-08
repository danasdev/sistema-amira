import { requireAuth } from "../auth.js";
import { initShell, escapeHtml, fmtData, erroCard } from "../ui.js";
import {
  db, collection, query, where, orderBy, getDocs, Timestamp,
  inicioDoDia, inicioDoMes, periodoParaIntervalo, getConfigIndicadores,
} from "../db.js";
import { brl, round2 } from "../money.js";
import { baseElegivelIndicador, baseElegivelIndicadorVenda, contaComoPago } from "../produtos-schema.js";
import { mapaDoCatalogo } from "../catalogo-cache.js";
import { listarCamadas, camadaPrincipal } from "../camadas.js";

// LEITURAS (mesma cota grátis do site): as vendas do MÊS são lidas uma vez
// só e servem para tudo do mês corrente — "hoje" é um recorte delas, e a
// contabilidade do mês atual reaproveita a mesma lista. Antes a mesma venda
// era lida até 3 vezes por abertura do painel (hoje, mês, contabilidade).
// Catálogo e camadas só são lidos se houver pedido de indicador no período.

const CANAIS = { loja: "Loja fisica", site: "Site proprio", mercado_livre: "Mercado Livre", shopee: "Shopee" };

const { perfil } = await requireAuth();
const root = initShell({ perfil, active: "dashboard" });
root.innerHTML = `<div class="card">Carregando...</div>`;

const ehAdm = perfil.role === "admin";
// Vendas do mes corrente ja lidas no topo (admin) — a contabilidade do mes
// atual reaproveita em vez de consultar de novo.
let vendasMesAtualCache = null;
const agoraDash = new Date();
const periodoAtual = `${agoraDash.getFullYear()}-${String(agoraDash.getMonth() + 1).padStart(2, "0")}`;

try {
const t0 = Timestamp.fromDate(inicioDoDia());
const m0 = Timestamp.fromDate(inicioDoMes());

// ---- vendas do mes (todos os status) — base de "hoje", do mes e da
// contabilidade do mes corrente. Filtra so por `data` (sem `status` na
// query, que exigiria um indice composto novo) e descarta os nao-concluidos
// em memoria.
const qMes = ehAdm
  ? query(collection(db, "vendas"), where("data", ">=", m0))
  : query(collection(db, "vendas"), where("vendedor_uid", "==", perfil.id), where("data", ">=", m0));
const vendasDoMes = (await getDocs(qMes)).docs.map((d) => d.data());
if (ehAdm) vendasMesAtualCache = vendasDoMes;
const millis = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0);

// ---- vendas de hoje (recorte do mes, mais recentes primeiro) ----
const vendasHoje = vendasDoMes
  .filter((v) => v.status === "concluida" && millis(v.data) >= t0.toMillis())
  .sort((a, b) => millis(b.data) - millis(a.data));

const totalHoje = vendasHoje.reduce((s, v) => s + (v.total || 0), 0);
const qtdHoje = vendasHoje.length;
const ticket = qtdHoje ? totalHoje / qtdHoje : 0;

const porCanal = {};
vendasHoje.forEach((v) => (porCanal[v.canal] = (porCanal[v.canal] || 0) + (v.total || 0)));

// ---- caixa aberto (unico pra loja toda, nao "do usuario") ----
const caixaDoc = (await getDocs(query(
  collection(db, "caixa"),
  where("status", "==", "aberto")
))).docs[0];
const caixa = caixaDoc ? caixaDoc.data() : null;

// ---- vendas do mes (todos os canais — comissao continua so canal loja) ----
const vendasMes = vendasDoMes.filter((v) => v.status === "concluida");
const qtdMes = vendasMes.length;
const totalMes = round2(vendasMes.reduce((s, v) => s + (v.total || 0), 0));
const comissaoMes = vendasMes
  .filter((v) => v.canal === "loja")
  .reduce((s, v) => s + (v.comissao?.valor || 0), 0);

// ---- top produtos hoje ----
const prod = {};
vendasHoje.forEach((v) =>
  (v.itens || []).forEach((it) => {
    // Catalogo do site nao tem `sku`; agrupa pelo produtoId (fallbacks p/ legado).
    const chave = it.produtoId || it.codigoBarras || it.sku || it.nome || "?";
    const p = prod[chave] || (prod[chave] = { nome: it.nome, qtd: 0, total: 0 });
    p.qtd += it.qtd || 0;
    p.total += it.subtotal || 0;
  })
);
const top = Object.values(prod).sort((a, b) => b.qtd - a.qtd).slice(0, 5);

root.innerHTML = `
  <div class="grid cols-6">
    <div class="card kpi"><div class="l">Vendas hoje</div><div class="n">${qtdHoje}</div></div>
    <div class="card kpi"><div class="l">Vendas no mes</div><div class="n">${qtdMes}</div></div>
    <div class="card kpi"><div class="l">Faturamento hoje</div><div class="n">${brl(totalHoje)}</div></div>
    <div class="card kpi"><div class="l">Faturamento no mes</div><div class="n">${brl(totalMes)}</div></div>
    <div class="card kpi"><div class="l">Ticket medio</div><div class="n">${brl(ticket)}</div></div>
    <div class="card kpi"><div class="l">${ehAdm ? "Comissoes no mes" : "Minha comissao no mes"}</div><div class="n">${brl(comissaoMes)}</div></div>
  </div>

  <div class="card">
    <strong>Caixa</strong>
    <p class="${caixa ? "" : "muted"}">${
      caixa
        ? `Aberto em ${fmtData(caixa.aberto_em)} por ${escapeHtml(caixa.aberto_por_nome || "-")} &middot; abertura ${brl(caixa.valor_abertura)}`
        : "Nenhum caixa aberto. Abra o caixa antes de vender em dinheiro."
    }</p>
    <a class="btn sec" href="/caixa">Ir para o caixa</a>
  </div>

  <div class="card">
    <strong>Vendas de hoje por canal</strong>
    <table><tbody>
      ${
        Object.entries(porCanal)
          .map(([c, v]) => `<tr><td>${CANAIS[c] || c}</td><td class="right">${brl(v)}</td></tr>`)
          .join("") || `<tr><td class="muted">Sem vendas hoje.</td></tr>`
      }
    </tbody></table>
  </div>

  <div class="card">
    <strong>Top produtos hoje</strong>
    <div class="tabela-wrap"><table>
      <thead><tr><th>Produto</th><th class="right">Qtd</th><th class="right">Total</th></tr></thead>
      <tbody>
        ${
          top
            .map((p) => `<tr><td>${escapeHtml(p.nome)}</td><td class="right">${p.qtd}</td><td class="right">${brl(p.total)}</td></tr>`)
            .join("") || `<tr><td class="muted">-</td></tr>`
        }
      </tbody>
    </table></div>
  </div>

  ${
    ehAdm
      ? `<div class="card">
    <strong>Contabilidade mensal</strong>
    <p class="muted">Junta loja + site: receita bruta, resultado do parcelamento (juros cobrados do cliente menos custo da maquininha), gastos, comissoes de vendedor e de indicador, e o valor liquido do mes. Independente do Caixa — soma direto de vendas e gastos por data, nao de sessoes de caixa.</p>
    <div class="row" style="align-items:end">
      <div><label>Periodo</label><input type="month" id="periodo-contab" value="${periodoAtual}"></div>
      <div style="flex:0 0 auto"><button class="btn ghost" id="ver-contab">Ver</button></div>
    </div>
    <div id="contab" style="margin-top:10px">Carregando...</div>
  </div>`
      : ""
  }`;

if (ehAdm) {
  document.getElementById("ver-contab").onclick = () =>
    carregarContabilidade(document.getElementById("periodo-contab").value || periodoAtual);
  carregarContabilidade(periodoAtual);
}
} catch (e) {
  erroCard(root, e);
}

// Contabilidade mensal: consulta `vendas` (loja + site) e `gastos` DIRETO
// por intervalo do mes — nunca soma documentos de `caixa`. Somar o "valor
// liquido" de cada sessao de caixa contaria gastos em dobro (cada sessao ja
// desconta os gastos do proprio periodo) e tem um buraco de cobertura: uma
// venda 100% credito pode fechar com caixa_id null se nao houver caixa
// aberto (so dinheiro bloqueia a venda sem caixa), entao nunca apareceria
// em nenhuma sessao.
async function carregarContabilidade(periodo) {
  const box = document.getElementById("contab");
  box.innerHTML = "Apurando...";
  try {
    const { inicio, fim } = periodoParaIntervalo(periodo);
    const ini = Timestamp.fromDate(inicio);
    const f = Timestamp.fromDate(fim);

    // Mes corrente: as vendas ja lidas no topo do painel. Outro mes: consulta.
    const doMes = periodo === periodoAtual && vendasMesAtualCache;
    const concluidasDoCanal = (canal) => vendasMesAtualCache.filter((v) => v.canal === canal && v.status === "concluida");
    const [vendasLoja, vendasSite, gastosSnap, cfgInd] = await Promise.all([
      doMes
        ? concluidasDoCanal("loja")
        : getDocs(query(collection(db, "vendas"), where("canal", "==", "loja"), where("status", "==", "concluida"), where("data", ">=", ini), where("data", "<", f))).then((s) => s.docs.map((d) => d.data())),
      doMes
        ? concluidasDoCanal("site")
        : getDocs(query(collection(db, "vendas"), where("canal", "==", "site"), where("status", "==", "concluida"), where("data", ">=", ini), where("data", "<", f))).then((s) => s.docs.map((d) => d.data())),
      getDocs(query(collection(db, "gastos"), where("data", ">=", ini), where("data", "<", f))),
      getConfigIndicadores(),
    ]);
    const gastosMes = gastosSnap.docs.map((d) => d.data());

    // Receita bruta = valor de tabela (`total`), igual pra loja e site — o
    // resultado do parcelamento entra a parte, na linha "Juros", pra nao
    // contar o mesmo dinheiro duas vezes.
    const receitaBruta = round2(
      vendasLoja.reduce((s, v) => s + (v.total || 0), 0) +
      vendasSite.reduce((s, v) => s + (v.total || 0), 0)
    );
    // Juros = resultado financeiro do parcelamento (juros cobrado do
    // cliente menos custo da loja com a maquininha/financiamento); pode ser
    // negativo se a loja cobra do cliente menos do que a taxa custa. Vem
    // direto dos campos brutos (total_com_juros/total/custo_loja_total), NAO
    // de `valor_liquido` — esse campo, no Caixa, desconta o custo da loja do
    // valor ORIGINAL de proposito (o juros do cliente fica so informativo
    // por la), entao nao serve pra medir o resultado do parcelamento aqui.
    // Site nao tem esse conceito (sem parcelamento com juros real).
    const juros = round2(
      vendasLoja.reduce((s, v) => {
        const jurosCliente = (v.total_com_juros ?? v.total ?? 0) - (v.total || 0);
        const custoLoja = v.custo_loja_total || 0;
        return s + (jurosCliente - custoLoja);
      }, 0)
    );
    const gastosTotal = round2(gastosMes.reduce((s, g) => s + (Number(g.valor) || 0), 0));
    const comissaoVendedores = round2(vendasLoja.reduce((s, v) => s + (v.comissao?.valor || 0), 0));

    // Comissao de indicadores do mes — mesma logica de indicadores.js
    // (baseElegivelIndicador, exclui iPhone/slugs excluidos), so que aqui
    // so precisamos do TOTAL do mes, nao do detalhamento por indicador.
    const pctInd = Number(cfgInd.percentual ?? 5);
    const excluirSlugs = cfgInd.categorias_excluidas || [];
    const pedidosSnap = await getDocs(query(collection(db, "pedidos"), where("criadoEm", ">=", ini), where("criadoEm", "<", f)));
    const pedidosDeIndicador = pedidosSnap.docs.map((d) => d.data()).filter((p) => p.ref && contaComoPago(p.status));
    // Vendas do PDV com indicador escolhido no balcao — ja estao em
    // vendasLoja (concluidas do mes), sem leitura extra.
    const vendasLojaDeIndicador = vendasLoja.filter((v) => v.ref);
    let baseIndicadores = 0;
    // Catalogo (cache da aba) e camadas so quando ha o que apurar.
    if (pedidosDeIndicador.length || vendasLojaDeIndicador.length) {
      const [produtosMap, camadas] = await Promise.all([mapaDoCatalogo(), listarCamadas()]);
      const opcoesBase = { camadaPrincipalSlug: camadaPrincipal(camadas)?.slug || null, excluirSlugs };
      pedidosDeIndicador.forEach((p) => {
        baseIndicadores = round2(baseIndicadores + baseElegivelIndicador(p, produtosMap, opcoesBase).base);
      });
      vendasLojaDeIndicador.forEach((v) => {
        baseIndicadores = round2(baseIndicadores + baseElegivelIndicadorVenda(v, produtosMap, opcoesBase).base);
      });
    }
    const comissaoIndicadores = round2(baseIndicadores * pctInd / 100);

    const valorLiquido = round2(receitaBruta + juros - gastosTotal - comissaoVendedores - comissaoIndicadores);

    box.innerHTML = `
      <div class="totais"><span>Receita bruta (loja + site)</span><span>${brl(receitaBruta)}</span></div>
      <div class="totais"><span>Juros (resultado do parcelamento)</span><span>${juros < 0 ? "- " : ""}${brl(Math.abs(juros))}</span></div>
      <div class="totais"><span>Gastos</span><span>- ${brl(gastosTotal)}</span></div>
      <div class="totais"><span>Comissao de vendedores</span><span>- ${brl(comissaoVendedores)}</span></div>
      <div class="totais"><span>Comissao de indicadores</span><span>- ${brl(comissaoIndicadores)}</span></div>
      <div class="totais big"><span>Valor liquido do mes</span><span>${brl(valorLiquido)}</span></div>
      <p class="muted" style="margin-top:8px">${vendasLoja.length} venda(s) de loja, ${vendasSite.length} do site, ${gastosMes.length} gasto(s) no periodo.</p>`;
  } catch (e) {
    erroCard(box, e, () => carregarContabilidade(periodo));
  }
}
