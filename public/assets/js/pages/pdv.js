import { requireAuth } from "../auth.js";
import { auth } from "../firebase.js";
import { initShell, toast, confirmar, escapeHtml, erroCard, tituloCard, vazio } from "../ui.js";
import { icone } from "../icons.js";
import {
  db, collection, getDocs, query, where,
  doc, runTransaction, serverTimestamp, getConfigSistema, increment,
} from "../db.js";
import { brl, round2, parseNum, valorCampo } from "../money.js";
import { calcularComissao } from "../regras.js";
import { infoPreco, estoquePorModo } from "../produtos-schema.js";
import { invalidarCatalogo } from "../catalogo-cache.js";
import { FORMAS_JUROS, FORMAS_PARCELAVEIS, parcelasDisponiveis, taxasDe, infoParcela, resumoTotais } from "../juros.js";
import {
  TIPO_POINT, criarClientePoint, novoCobrancaId, quemPagaJuros, marcarAprovada, pagamentoDaMaquininha,
  configPointEfetiva, storageSeguro, desativarTesteLocal, totalDaCobranca,
} from "../point.js";
import { cobrarNaMaquininha } from "../point-ui.js";
import { dividaDoCrediario } from "../crediario.js";
import { editarCliente, listarClientes } from "../clientes.js";

const { perfil } = await requireAuth();
const root = initShell({ perfil, active: "pdv", largo: true });
root.innerHTML = `<div class="card">Carregando...</div>`;

try {
const config = await getConfigSistema();
const formas = config.formas_pagamento?.length
  ? config.formas_pagamento
  : ["dinheiro", "pix", "debito", "credito", "crediario"];
const parc = config.parcelamento || { maximo: 12, minimo_parcela: 0, juros: {} };

// Maquininha Mercado Pago Point (opcional — Configuracoes → Maquininha). Com
// ela ligada, credito/debito ganham o botao "Cobrar na maquininha"; sem ela
// (ou com a API fora do ar) o registro manual de cartao continua igual.
// "Teste local" (Configuracoes → Maquininha) liga a maquininha so NESTE
// navegador, apontando pra API local — sem mexer na config de todo mundo.
const pointCfg = configPointEfetiva(config.point, storageSeguro());
const pointAtivo = pointCfg.ativo === true;
const pointObrigatorio = pointAtivo && pointCfg.obrigatorio === true;
const clientePoint = pointAtivo
  ? criarClientePoint({ apiBase: pointCfg.api_url, obterToken: () => auth.currentUser.getIdToken() })
  : null;

// Caixa e UNICO pra loja toda — nao e "do usuario logado". Qualquer
// vendedor/admin vende contra o mesmo caixa aberto, seja quem for que
// abriu de manha.
const caixaDoc = (await getDocs(query(
  collection(db, "caixa"),
  where("status", "==", "aberto")
))).docs[0];
const caixaAbertoId = caixaDoc ? caixaDoc.id : null;

// produtos vendaveis (schema do site: `ativo`; ordena/filtra em memoria pra
// nao depender de indice composto)
const produtos = (await getDocs(collection(db, "produtos"))).docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((p) => p.ativo !== false)
  .sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));

// Indicadores (divulgadores) que podem ser atribuidos a venda — a venda
// grava `ref` = codigo, o mesmo campo do pedido do site, e entra na
// comissao do indicador (ver ../vendas-indicador.js). So os ativos. Se a
// lista nao carregar, o PDV segue vendendo sem o campo.
const indicadores = await getDocs(collection(db, "indicadores"))
  .then((s) => s.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.ativo !== false && r.codigo)
    .sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR")))
  .catch(() => []);

// Clientes cadastrados (pagina Clientes). Crediario EXIGE um deles: a
// divida fica no perfil do cliente. Nas outras formas e opcional (so liga a
// compra ao historico do cliente).
let clientes = await listarClientes().catch(() => []);
// Formas em que o cliente pode pagar a parcela na hora do crediario.
const formasEntrada = formas.filter((f) => f !== "crediario");
const formaEntradaDe = (p) => p.entrada_forma || (formasEntrada.includes("dinheiro") ? "dinheiro" : formasEntrada[0]);

// preco de venda (varejo, com desconto do site aplicado); estoque e um so
// pool (nao ha mais divisao varejo/atacado)
const precoDe = (p) => infoPreco(p, "varejo").precoFinal;
const estoqueDe = (p) => estoquePorModo(p);

let carrinho = [];
let pagamentos = [];
let ultimoAdicionado = null; // realce do item que acabou de entrar na sacola
let qtdAnterior = 0;

const FORMA_INFO = {
  dinheiro: { rotulo: "Dinheiro", ic: "dinheiro" },
  pix: { rotulo: "Pix", ic: "pix" },
  debito: { rotulo: "Débito", ic: "debito" },
  credito: { rotulo: "Crédito", ic: "cartao" },
  crediario: { rotulo: "Crediário", ic: "crediario" },
};
const rotuloForma = (f) => FORMA_INFO[f]?.rotulo || f;
const iconeForma = (f) => icone(FORMA_INFO[f]?.ic || "cartao", { tam: 18 });

root.innerHTML = `
  ${pointCfg.testeLocal ? `
  <div class="pt-banner-local" id="pt-banner-local">
    <div><strong>TESTE LOCAL da maquininha</strong> — ligada só neste computador, usando a API em <code>${escapeHtml(pointCfg.api_url)}</code>.
    As vendas feitas aqui são <strong>reais</strong>: gravam no sistema e baixam o estoque.</div>
    <button class="btn ghost" id="pt-local-off">Desativar teste local</button>
  </div>` : ""}
  <div class="pdv">
    <section class="card pdv-produtos" aria-label="Adicionar produtos">
      ${tituloCard("pdv", "Adicionar produtos")}
      ${caixaAbertoId ? "" : `<div class="faixa" style="margin-bottom:12px">${icone("aviso", { tam: 16 })}<div>Nenhum caixa aberto: pagamento em dinheiro fica bloqueado. <a href="/caixa">Abrir caixa</a></div></div>`}
      <div class="leitor">
        <div class="leitor-rotulo">${icone("pdv", { tam: 18 })}<span>Leitor de código de barras</span><span class="leitor-estado" id="leitor-estado">pronto pra bipar</span></div>
        <input id="bipar" placeholder="Clique aqui e bipe o produto" autocomplete="off" inputmode="numeric" aria-label="Código de barras">
      </div>
      <label for="busca-prod">Ou procure na lista</label>
      <div class="campo-ic">${icone("busca", { tam: 18 })}<input id="busca-prod" placeholder="Nome ou código do produto" autocomplete="off"></div>
      <div id="resultados" class="prod-lista"></div>
    </section>

    <section class="card pdv-sacola" aria-label="Sacola da venda">
      <div class="sacola-head">
        <h2>${icone("sacola", { tam: 22 })}Sacola</h2>
        <span class="contador vazio-c" id="contador" aria-label="Itens na sacola">0</span>
      </div>
      <div class="sacola-itens" id="cart"></div>
      <div class="sacola-pe">
        <div class="desc-linha"><span>Subtotal</span><strong class="num" id="sacola-sub">R$ 0,00</strong></div>
        <div class="desc-linha" style="margin-top:8px">
          <label for="desconto" style="margin:0">Desconto</label>
          <div class="campo-rs"><input id="desconto" value="0,00" inputmode="decimal"></div>
        </div>
        <div class="sacola-total"><span>Total da sacola</span><span id="sacola-total">R$ 0,00</span></div>
      </div>
    </section>

    <div class="pdv-checkout">
      <section class="card" aria-label="Cliente">
        ${tituloCard("usuario", "Cliente")}
        <label for="cliente-perfil" style="margin-top:0">Cliente cadastrado <span class="opc">· obrigatório no crediário</span></label>
        <div class="row" style="flex-wrap:nowrap;gap:8px">
          <select id="cliente-perfil"></select>
          <button class="btn sec" id="novo-cliente" style="flex:0 0 auto">${icone("novoUsuario", { tam: 16 })}Novo</button>
        </div>
        <div class="row" style="gap:10px">
          <div><label for="cliente">Nome</label><input id="cliente" placeholder="Nome do cliente" autocomplete="off" required></div>
          <div><label for="cliente-contato">Contato</label><input id="cliente-contato" placeholder="Telefone / WhatsApp" autocomplete="off" required></div>
        </div>
        <details class="mais">
          <summary>${indicadores.length ? "Indicador e observações" : "Observações"} <span class="opc">(opcional)</span></summary>
          ${indicadores.length ? `
          <label for="indicador">Indicador</label>
          <select id="indicador">
            <option value="">Sem indicador</option>
            ${indicadores.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.nome || r.codigo)} (${escapeHtml(r.codigo)})</option>`).join("")}
          </select>` : ""}
          <label for="observacoes">Observações</label>
          <textarea id="observacoes" rows="2" placeholder="Ex.: embrulho pra presente, retirar às 18h..."></textarea>
        </details>
      </section>

      <section class="card" aria-label="Pagamento">
        ${tituloCard("cartao", "Pagamento")}
        <p class="dica" style="margin:-4px 0 10px">Toque na forma de pagamento. O valor que falta já vem preenchido; pra dividir, ajuste o valor e escolha outra forma.</p>
        <div class="formas" id="formas-rapidas">
          ${formas.map((f) => `<button class="forma-btn" data-forma="${escapeHtml(f)}">${iconeForma(f)}${escapeHtml(rotuloForma(f))}</button>`).join("")}
        </div>
        <div id="pags"></div>
      </section>

      <section class="card resumo" aria-label="Resumo da venda">
        <div id="totais"></div>
        <div class="acoes">
          <button class="btn lg" id="finalizar">${icone("check", { tam: 20 })}Finalizar venda</button>
          <button class="btn ghost lg" id="limpar" title="Esvaziar a venda">${icone("lixo", { tam: 18 })}Limpar</button>
        </div>
      </section>
    </div>
  </div>`;

const $ = (s) => root.querySelector(s);

$("#busca-prod").oninput = renderResultados;
$("#bipar").focus();
$("#bipar").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  bipar($("#bipar").value.trim());
  $("#bipar").value = "";
};
$("#bipar").onfocus = () => ($("#leitor-estado").textContent = "pronto pra bipar");
$("#bipar").onblur = () => ($("#leitor-estado").textContent = "clique pra usar o leitor");
$("#desconto").oninput = renderTotais;
$("#desconto").onchange = () => ($("#desconto").value = valorCampo(parseNum($("#desconto").value)));
$("#desconto").onfocus = () => $("#desconto").select();
root.querySelectorAll(".forma-btn").forEach((b) => (b.onclick = () => adicionarPagamento(b.dataset.forma)));
$("#limpar").onclick = limpar;
$("#cliente-perfil").onchange = aplicarClientePerfil;
$("#novo-cliente").onclick = () =>
  editarCliente(null, {
    perfil,
    onSalvo: (c) => {
      clientes = [...clientes, c].sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));
      renderClientes(c.id);
      aplicarClientePerfil();
    },
  });
$("#finalizar").onclick = finalizar;
if (pointCfg.testeLocal) {
  $("#pt-local-off").onclick = () => {
    desativarTesteLocal(storageSeguro());
    location.reload();
  };
}

renderClientes("");
renderResultados();
renderCart();
renderPags();
renderTotais();

function clienteSelecionado() {
  return clientes.find((c) => c.id === $("#cliente-perfil").value) || null;
}

function renderClientes(selecionado) {
  $("#cliente-perfil").innerHTML =
    `<option value="">Sem cadastro</option>` +
    clientes
      .map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === selecionado ? "selected" : ""}>${escapeHtml(c.nome)}${c.contato ? ` (${escapeHtml(c.contato)})` : ""}</option>`)
      .join("");
}

// Cliente cadastrado preenche (e trava) nome e contato da venda.
function aplicarClientePerfil() {
  const c = clienteSelecionado();
  $("#cliente").value = c ? c.nome || "" : "";
  $("#cliente-contato").value = c ? c.contato || "" : "";
  $("#cliente").readOnly = !!c;
  $("#cliente-contato").readOnly = !!c;
}

// Recarregar/fechar a aba com cobranca na maquininha em curso (ou ja
// aprovada e ainda sem venda) perderia o vinculo: o cliente pagou, o
// sistema nao sabe. O navegador pergunta antes.
window.addEventListener("beforeunload", (e) => {
  if (pagamentos.some((p) => p.point)) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function adicionarPagamento(forma) {
  if (!carrinho.length) return toast("Adicione produtos na sacola antes de escolher o pagamento.", "warn");
  const { total, pago } = calc();
  const falta = round2(Math.max(0, total - pago));
  if (falta <= 0 && pagamentos.length)
    return toast("O valor da venda já está todo distribuído. Ajuste um valor antes de adicionar outra forma.", "info");
  pagamentos.push({ forma, valor: falta, parcelas: 1 });
  renderPags();
  renderTotais();
  // foco no valor da forma recem-adicionada (pra dividir o pagamento)
  const inputs = $("#pags").querySelectorAll(".pv");
  inputs[inputs.length - 1]?.select();
}

function renderResultados() {
  const termo = $("#busca-prod").value.toLowerCase().trim();
  const lista = produtos
    .filter(
      (p) =>
        !termo ||
        (p.nome || "").toLowerCase().includes(termo) ||
        (p.sku || "").toLowerCase().includes(termo) ||
        (p.codigoBarras || "").toLowerCase().includes(termo)
    )
    .slice(0, 40);
  $("#resultados").innerHTML =
    lista
      .map((p) => {
        const est = estoqueDe(p);
        const estTxt = est <= 0 ? `<span class="estoque-baixo">sem estoque</span>` : est <= 3 ? `<span class="estoque-baixo">só ${est} em estoque</span>` : `<span>${est} em estoque</span>`;
        return `<button class="prod add" data-id="${p.id}" ${est <= 0 ? "disabled" : ""} title="Adicionar à sacola">
          <span class="p-info">
            <span class="p-nome">${escapeHtml(p.nome)}</span>
            <span class="p-meta"><span>${escapeHtml(p.codigoBarras || p.sku || "sem código")}</span>${estTxt}</span>
          </span>
          <span class="p-preco">${brl(precoDe(p))}</span>
          <span class="p-add">${icone("mais", { tam: 18 })}</span>
        </button>`;
      })
      .join("") || vazio("busca", "Nenhum produto encontrado", "Confira o nome ou o código. Produtos inativos não aparecem aqui.");
  $("#resultados")
    .querySelectorAll(".add")
    .forEach((b) => (b.onclick = () => {
      addItem(b.dataset.id);
      $("#bipar").focus();
    }));
}

function bipar(codigo) {
  if (!codigo) return;
  const p = produtos.find((x) => (x.codigoBarras || "") === codigo);
  if (!p) return toast(`Código ${codigo} não encontrado. O produto pode estar inativo ou sem código cadastrado.`, "warn");
  addItem(p.id);
  $("#bipar").focus();
}

function addItem(id) {
  const p = produtos.find((x) => x.id === id);
  const linha = carrinho.find((l) => l.produtoId === id);
  const qAtual = linha ? linha.qtd : 0;
  if (qAtual + 1 > estoqueDe(p)) return toast(`Estoque insuficiente de ${p.nome} (tem ${estoqueDe(p)}).`, "warn");
  ultimoAdicionado = id;
  if (linha) linha.qtd++;
  else
    carrinho.push({
      produtoId: id,
      sku: p.sku || "",
      codigoBarras: p.codigoBarras || "",
      nome: p.nome,
      preco_unit: precoDe(p),
      preco_custo: 0, // catalogo do site nao guarda custo
      qtd: 1,
    });
  renderCart();
  renderTotais();
}

function renderCart() {
  const qtdItens = carrinho.reduce((s, l) => s + l.qtd, 0);
  const cont = $("#contador");
  cont.textContent = qtdItens;
  cont.classList.toggle("vazio-c", !qtdItens);
  cont.setAttribute("aria-label", `${qtdItens} ${qtdItens === 1 ? "item" : "itens"} na sacola`);
  if (qtdItens > qtdAnterior) {
    cont.classList.remove("pulou");
    void cont.offsetWidth; // reinicia a animacao
    cont.classList.add("pulou");
  }
  qtdAnterior = qtdItens;

  $("#cart").innerHTML =
    carrinho
      .map(
        (l, i) => `<div class="item ${l.produtoId === ultimoAdicionado ? "novo" : ""}">
          <div>
            <div class="i-nome">${escapeHtml(l.nome)}</div>
            <div class="i-unit">${brl(l.preco_unit)} cada</div>
          </div>
          <div class="qtd">
            <button class="menos" data-i="${i}" aria-label="Diminuir quantidade">${icone("menos", { tam: 14 })}</button>
            <input type="number" min="1" value="${l.qtd}" data-i="${i}" class="q" aria-label="Quantidade">
            <button class="mais" data-i="${i}" aria-label="Aumentar quantidade">${icone("mais", { tam: 14 })}</button>
          </div>
          <div class="i-total">${brl(l.preco_unit * l.qtd)}</div>
          <button class="rm" data-i="${i}" aria-label="Tirar ${escapeHtml(l.nome)} da sacola" title="Tirar da sacola">${icone("lixo", { tam: 16 })}</button>
        </div>`
      )
      .join("") || vazio("sacola", "A sacola está vazia", "Bipe um produto ou procure pelo nome pra começar a venda.");
  ultimoAdicionado = null;

  const mudarQtd = (i, q) => {
    const p = produtos.find((x) => x.id === carrinho[i].produtoId);
    if (q > estoqueDe(p)) {
      toast(`Estoque insuficiente de ${carrinho[i].nome} (tem ${estoqueDe(p)}).`, "warn");
      renderCart();
      return;
    }
    if (q < 1) return;
    carrinho[i].qtd = q;
    renderCart();
    renderTotais();
  };
  $("#cart").querySelectorAll(".q").forEach((inp) => {
    inp.onchange = () => mudarQtd(+inp.dataset.i, Math.max(1, Math.trunc(+inp.value || 1)));
  });
  $("#cart").querySelectorAll(".mais").forEach((b) => (b.onclick = () => mudarQtd(+b.dataset.i, carrinho[+b.dataset.i].qtd + 1)));
  $("#cart").querySelectorAll(".menos").forEach((b) => (b.onclick = () => mudarQtd(+b.dataset.i, carrinho[+b.dataset.i].qtd - 1)));
  $("#cart").querySelectorAll(".rm").forEach((b) => {
    b.onclick = () => {
      carrinho.splice(+b.dataset.i, 1);
      renderCart();
      renderTotais();
    };
  });
}

function renderPags() {
  $("#pags").innerHTML = pagamentos
    .map((pg, i) => {
      const parcelavel = FORMAS_PARCELAVEIS.has(pg.forma);
      // Com cobranca na maquininha criada (em andamento ou aprovada) a linha
      // fica travada: forma, valor e parcelas ja foram pra maquininha e o
      // que vale agora e o que ela reportar.
      const pt = pg.point;
      const travado = pt ? "disabled" : "";
      let linhaParcelas = "";
      if (parcelavel) {
        // Linha travada nao recalcula as opcoes: as parcelas podem ter sido
        // trocadas pelo cliente na maquininha e nao podem ser "corrigidas".
        const opcoes = pt ? [pg.parcelas || 1] : parcelasDisponiveis(pg.valor, parc);
        const numParcelas = opcoes.includes(pg.parcelas) ? pg.parcelas : 1;
        if (!pt) pg.parcelas = numParcelas;
        linhaParcelas = `
          <div>
            <label style="margin-top:0">Parcelas</label>
            <select data-i="${i}" class="pp" ${travado}>
              ${opcoes
                .map((n) => {
                  const j = taxasDe(config, pg.forma, n).cliente;
                  return `<option value="${n}" ${n === numParcelas ? "selected" : ""}>${n}x${j ? ` (${j}% juros)` : " sem juros"}</option>`;
                })
                .join("")}
            </select>
          </div>`;
      }
      // Mostra a taxa do CLIENTE (somada ao que ele paga) e da LOJA (custo de
      // maquininha/financiamento, descontado do que a loja recebe) pra
      // qualquer forma em FORMAS_JUROS — inclusive debito, que nao parcela
      // mas pode ter taxa a vista configurada em "1". Sem isso o vendedor nao
      // tinha como ver o custo da loja antes de finalizar a venda.
      let linhaTaxa = "";
      // Com cobranca na maquininha o que vale sao os numeros dela (linha
      // "Cobrado na maquininha"), nao a estimativa da tabela.
      if (!pt && FORMAS_JUROS.includes(pg.forma)) {
        const { pctCliente, pctLoja, valorComJuros, custoLoja, valorParcela, parcelas } = infoPagamento(pg);
        const partes = pctCliente || pctLoja
          ? [
              parcelavel && parcelas > 1 ? `${parcelas}x de ${brl(valorParcela)}` : "",
              `cliente: ${pctCliente ? `+${pctCliente}% (total ${brl(valorComJuros)})` : "sem juros"}`,
              `loja: ${pctLoja ? `-${pctLoja}% (${brl(custoLoja)} de custo)` : "sem custo"}`,
            ].filter(Boolean)
          : [`sem taxa configurada pra ${rotuloForma(pg.forma)}${parcelavel ? ` em ${pg.parcelas}x` : ""} — ajuste em Configurações`];
        linhaTaxa = `<p class="pag-info">${partes.join(" &middot; ")}</p>`;
      }
      // Botao/estado da maquininha (so credito e debito, e so com Point ligado).
      let linhaPoint = "";
      if (clientePoint && TIPO_POINT[pg.forma]) {
        if (pt && pt.status === "processed") {
          linhaPoint = `<div class="pt-linha">
            <span class="pt-ok">Cobrado na maquininha</span>
            <span class="muted">${escapeHtml(descricaoAprovada(pg))}</span>
            ${perfil.role === "admin" ? `<button class="btn ghost pt-estornar" data-i="${i}">Estornar</button>` : ""}
          </div>`;
        } else if (pt) {
          linhaPoint = `<div class="pt-linha">
            <span class="pt-pend">Cobrança em andamento na maquininha</span>
            <button class="btn ghost pt-acompanhar" data-i="${i}">Acompanhar</button>
          </div>`;
        } else {
          linhaPoint = `<div class="pt-linha">
            <button class="btn sec pt-cobrar" data-i="${i}" ${pg.valor > 0 ? "" : "disabled"}>${icone("cartao", { tam: 16 })}Cobrar na maquininha</button>
          </div>`;
        }
      }
      // Crediario: o cliente pode pagar uma parte na hora — so ESSE valor
      // entra no caixa; o resto fica como divida no perfil do cliente.
      let linhaCrediario = "";
      if (pg.forma === "crediario") {
        const divida = dividaDoCrediario(pagamentosComJuros([pg])[0]);
        const entrada = Math.min(pg.entrada || 0, divida);
        linhaCrediario = `
          <div class="crediario-box">
            <div class="row" style="gap:10px">
              <div><label style="margin-top:0">Valor de parcela paga</label>
                <div class="campo-rs"><input class="pent" data-i="${i}" value="${valorCampo(pg.entrada || 0)}" inputmode="decimal"></div></div>
              <div><label style="margin-top:0">Pago em</label>
                <select class="pentf" data-i="${i}">${formasEntrada
                  .map((f) => `<option value="${escapeHtml(f)}" ${f === formaEntradaDe(pg) ? "selected" : ""}>${escapeHtml(rotuloForma(f))}</option>`)
                  .join("")}</select></div>
            </div>
            <p class="pag-info">Vai pro caixa agora: <strong>${brl(entrada)}</strong> &middot; fica na conta do cliente: <strong>${brl(round2(divida - entrada))}</strong></p>
          </div>`;
      }
      const extra = linhaParcelas + linhaPoint + linhaTaxa + linhaCrediario;
      return `<div class="pag">
        <div class="pag-head">
          <div class="pag-nome">${iconeForma(pg.forma)}<span>${escapeHtml(rotuloForma(pg.forma))}</span></div>
          <div class="campo-rs"><input class="pv" data-i="${i}" value="${valorCampo(pg.valor)}" inputmode="decimal" aria-label="Valor em ${escapeHtml(rotuloForma(pg.forma))}" ${travado}></div>
          <button class="btn ghost so-ic sm prm" data-i="${i}" aria-label="Remover ${escapeHtml(rotuloForma(pg.forma))}" title="Remover" ${travado}>${icone("fechar", { tam: 16 })}</button>
        </div>
        ${extra ? `<div class="pag-extra">${extra}</div>` : ""}
      </div>`;
    })
    .join("");
  $("#pags")
    .querySelectorAll(".pv")
    .forEach(
      (inp) =>
        (inp.onchange = () => {
          pagamentos[+inp.dataset.i].valor = round2(parseNum(inp.value));
          renderPags();
          renderTotais();
        })
    );
  $("#pags")
    .querySelectorAll(".pp")
    .forEach(
      (s) =>
        (s.onchange = () => {
          pagamentos[+s.dataset.i].parcelas = Math.trunc(+s.value) || 1;
          renderPags();
          renderTotais();
        })
    );
  $("#pags")
    .querySelectorAll(".pent")
    .forEach(
      (inp) =>
        (inp.onchange = () => {
          pagamentos[+inp.dataset.i].entrada = Math.max(0, round2(parseNum(inp.value)));
          renderPags();
          renderTotais();
        })
    );
  $("#pags")
    .querySelectorAll(".pentf")
    .forEach((s) => (s.onchange = () => (pagamentos[+s.dataset.i].entrada_forma = s.value)));
  $("#pags")
    .querySelectorAll(".prm")
    .forEach((b) => {
      b.onclick = () => {
        pagamentos.splice(+b.dataset.i, 1);
        renderPags();
        renderTotais();
      };
    });
  $("#pags").querySelectorAll(".pt-cobrar").forEach((b) => (b.onclick = () => cobrarLinha(pagamentos[+b.dataset.i])));
  $("#pags").querySelectorAll(".pt-acompanhar").forEach((b) => (b.onclick = () => acompanharLinha(pagamentos[+b.dataset.i])));
  $("#pags").querySelectorAll(".pt-estornar").forEach((b) => (b.onclick = () => estornarLinha(pagamentos[+b.dataset.i])));
}

// ── Cobranca na maquininha (Mercado Pago Point) ──────────────────────────
function descricaoAprovada(pg) {
  const pt = pg.point;
  const partes = [];
  if (pt.bandeira) partes.push(pt.bandeira);
  partes.push(FORMAS_PARCELAVEIS.has(pg.forma) && pg.parcelas > 1 ? `${pg.parcelas}x` : "a vista");
  if (pt.valor_pago != null) partes.push(`${brl(pt.valor_pago)} cobrado`);
  if (pt.custo_loja != null) partes.push(`taxa ${brl(pt.custo_loja)}`);
  return partes.join(" · ");
}

// Topo do modal da maquininha: o TOTAL que o cliente vai pagar (em destaque) e,
// embaixo, parcelas, valor original e juros. Com juros pro cliente o total e
// estimativa pela tabela (o percentual real do juros e do Mercado Pago).
function resumoCobranca(pg, parcelas) {
  const taxas = taxasDe(config, pg.forma, parcelas);
  const t = totalDaCobranca({ valor: pg.valor, parcelas, taxas, quemPaga: quemPagaJuros({ tipo: TIPO_POINT[pg.forma], parcelas, taxas }) });
  const partes = [`${pg.forma}${t.parcelas > 1 ? ` em ${t.parcelas}x de ${brl(t.valorParcela)}` : ""}`];
  if (t.juros > 0) partes.push(`valor original ${brl(t.valorOriginal)}`, `juros do cliente ${brl(t.juros)}`);
  else partes.push("sem juros pro cliente");
  return { rotulo: "Total a cobrar do cliente", total: brl(t.total), estimado: t.estimado, detalhe: partes.join(" · ") };
}

// A linha e um objeto (nao um indice): enquanto o modal esta aberto a tela
// fica bloqueada, mas o objeto continua valendo mesmo se a lista mudar.
function aplicarResultadoPoint(pg, r) {
  if (!pagamentos.includes(pg)) return;
  if (r.resultado === "aprovada") {
    marcarAprovada(pg, r.cobranca);
    toast("Pagamento aprovado na maquininha.", "ok");
  } else if (r.resultado === "pendente") {
    // Modal fechado com a cobranca ainda viva: a linha continua travada.
    toast("A cobranca segue na maquininha. Use \"Acompanhar\" na linha do pagamento.", "warn");
  } else {
    delete pg.point; // nada foi cobrado: destrava a linha
    if (r.resultado === "falhou") toast(r.erro?.message || "Nao foi possivel cobrar na maquininha.", "err");
    else if (r.resultado === "inexistente") toast("A cobranca nao chegou a ser criada. Tente de novo.", "warn");
  }
  renderPags();
  renderTotais();
}

async function cobrarLinha(pg) {
  const tipo = pg && TIPO_POINT[pg.forma];
  if (!tipo || pg.point || !(pg.valor > 0)) return;
  const parcelas = tipo === "credit_card" ? Math.max(1, Math.trunc(pg.parcelas) || 1) : 1;
  const cobrancaId = novoCobrancaId();
  pg.point = { cobrancaId, status: "pendente" };
  renderPags();
  renderTotais();
  const r = await cobrarNaMaquininha({
    cliente: clientePoint,
    cobrancaId,
    params: {
      cobrancaId,
      tipo,
      valor: pg.valor,
      parcelas,
      // Quem paga o juros segue a tabela ja configurada: cliente com juros > 0
      // no parcelamento = o cliente paga; senao a loja absorve.
      quemPagaJuros: quemPagaJuros({ tipo, parcelas, taxas: taxasDe(config, pg.forma, parcelas) }),
    },
    resumo: resumoCobranca(pg, parcelas),
  });
  aplicarResultadoPoint(pg, r);
}

async function acompanharLinha(pg) {
  if (!pg?.point || pg.point.status === "processed") return;
  const r = await cobrarNaMaquininha({
    cliente: clientePoint,
    cobrancaId: pg.point.cobrancaId,
    jaCriada: true,
    resumo: resumoCobranca(pg, pg.parcelas || 1),
  });
  aplicarResultadoPoint(pg, r);
}

// Desfazer uma cobranca ja aprovada = estorno total no cartao (so admin: o
// servidor tambem confere).
async function estornarLinha(pg) {
  if (!pg?.point || pg.point.status !== "processed") return;
  const valor = pg.point.valor_pago ?? pg.valor;
  if (!(await confirmar(`Estornar ${brl(valor)} no cartao do cliente? O pagamento e cancelado na maquininha.`, { textoConfirmar: "Estornar" }))) return;
  try {
    await clientePoint.estornar(pg.point.cobrancaId);
    delete pg.point;
    toast("Pagamento estornado.", "ok");
    renderPags();
    renderTotais();
  } catch (e) {
    toast(e?.message || "Falha ao estornar.", "err");
  }
}

function calc() {
  const subtotal = round2(carrinho.reduce((s, l) => s + l.preco_unit * l.qtd, 0));
  const desconto = Math.max(0, round2(parseNum($("#desconto").value)));
  const total = round2(subtotal - desconto);
  // `pago` continua validando contra o valor ORIGINAL (pg.valor) de cada
  // forma — o juros do cliente e um acrescimo no que a maquininha cobra,
  // nao muda quanto do total da venda aquela forma "cobre". Isso mantem a
  // validacao pago===total intacta mesmo com juros de verdade.
  const pago = round2(pagamentos.reduce((s, p) => s + (p.valor || 0), 0));
  return { subtotal, desconto, total, pago };
}

// Info completa de juros pra um pagamento — mesma regra usada em renderPags,
// no preview do total e na hora de gravar a venda: forma parcelavel usa a
// quantidade escolhida, as demais (ex.: debito) usam sempre 1x.
function infoPagamento(p) {
  const parcelas = FORMAS_PARCELAVEIS.has(p.forma) ? Math.max(1, Math.trunc(p.parcelas) || 1) : 1;
  return { parcelas, ...infoParcela(p.valor || 0, parcelas, taxasDe(config, p.forma, parcelas)) };
}

// pg.valor continua sendo o valor ORIGINAL (de tabela) alocado pra essa
// forma — os campos de juros abaixo sao aditivos, pra nao mexer em nada que
// ja le `valor`/`total` da venda (comissao do vendedor, listagem de Vendas,
// dashboard, relatorios). So grava os campos de juros quando ha taxa
// configurada pra essa forma+parcelas (cobre credito/crediario parcelado E
// credito/debito a vista com taxa de maquininha). Usada tanto no preview
// (renderTotais) quanto ao finalizar, pra nunca divergir do que e salvo.
function pagamentosComJuros(pags) {
  return pags.map((p) => comCrediario(p, pagamentoComJuros(p)));
}

// Linha de crediario guarda quanto o cliente pagou na hora (`entrada`, em
// `entrada_forma`) e quanto ficou devendo (`saldo_devedor`).
function comCrediario(p, salvo) {
  if (p.forma !== "crediario") return salvo;
  const divida = dividaDoCrediario(salvo);
  const entrada = Math.min(Math.max(0, round2(p.entrada || 0)), divida);
  return { ...salvo, entrada, entrada_forma: formaEntradaDe(p), saldo_devedor: round2(divida - entrada) };
}

function pagamentoComJuros(p) {
  // Pago na maquininha: valem os numeros que ela informou (custo real,
  // valor cobrado, parcelas); o que faltar cai na estimativa da tabela.
  if (p.point?.status === "processed") {
    const est = infoPagamento({ ...p, parcelas: p.point.parcelas ?? p.parcelas });
    return pagamentoDaMaquininha(p, est, FORMAS_PARCELAVEIS.has(p.forma));
  }
  const valor = round2(p.valor);
  const base = { forma: p.forma, valor };
  if (!FORMAS_JUROS.includes(p.forma)) return base;
  const { parcelas, pctCliente, pctLoja, valorComJuros, custoLoja, valorLiquido, valorParcela } = infoPagamento(p);
  // Parcelas sao gravadas mesmo sem taxa: o Caixa precisa delas pra contar
  // so uma parcela do credito (../crediario.js).
  const comParcelas = FORMAS_PARCELAVEIS.has(p.forma) && parcelas > 1
    ? { ...base, parcelas, valor_parcela: valorParcela }
    : base;
  if (!pctCliente && !pctLoja) return comParcelas;
  return {
    ...comParcelas,
    juros_pct: pctCliente,
    pct_loja: pctLoja,
    valor_com_juros: valorComJuros,
    custo_loja: custoLoja,
    valor_liquido: valorLiquido,
  };
}

function agregarJuros(pagsComJuros) {
  const totalComJuros = round2(pagsComJuros.reduce((s, p) => s + (p.valor_com_juros ?? p.valor), 0));
  const custoLojaTotal = round2(pagsComJuros.reduce((s, p) => s + (p.custo_loja || 0), 0));
  const valorLiquido = round2(pagsComJuros.reduce((s, p) => s + (p.valor_liquido ?? p.valor), 0));
  return { totalComJuros, custoLojaTotal, valorLiquido };
}

// O "Total" grande e o que o cliente PAGA (ja com juros, o que a maquininha
// cobra); logo abaixo o valor original do produto, o custo da loja e o que a
// loja recebe. As contas estao em resumoTotais (juros.js, com testes). O
// "Finalizar" continua validando em valor ORIGINAL (calc), nada mudou nisso.
function renderTotais() {
  const { subtotal, desconto, total, pago } = calc();
  const r = resumoTotais({ total, pago, pagamentos: pagamentosComJuros(pagamentos) });
  $("#sacola-sub").textContent = brl(subtotal);
  $("#sacola-total").textContent = brl(total);
  root.querySelectorAll(".forma-btn").forEach((b) => (b.disabled = !carrinho.length));

  // Situacao do pagamento: o que a vendedora precisa saber de relance.
  let status;
  if (!carrinho.length) status = `<div class="status-pag falta">${icone("sacola", { tam: 18 })}<span>Adicione produtos pra começar</span></div>`;
  else if (!pagamentos.length) status = `<div class="status-pag falta">${icone("cartao", { tam: 18 })}<span>Escolha a forma de pagamento</span></div>`;
  else if (r.falta > 0) status = `<div class="status-pag falta">${icone("aviso", { tam: 18 })}<span>Falta distribuir</span><span class="num">${brl(r.falta)}</span></div>`;
  else if (r.falta < 0) status = `<div class="status-pag troco">${icone("dinheiro", { tam: 18 })}<span>Troco</span><span class="num">${brl(-r.falta)}</span></div>`;
  else status = `<div class="status-pag ok">${icone("sucesso", { tam: 18 })}<span>Pagamento completo</span></div>`;
  const pct = total > 0 ? Math.min(100, Math.max(0, (pago / total) * 100)) : 0;

  $("#totais").innerHTML = `
    <div class="r-total">
      <span class="r-rot">${r.mostrarOriginal ? `Total a cobrar${r.estimadoCobranca ? " <span class='opc'>(estimado)</span>" : ""}` : "Total"}</span>
      <span class="r-val">${brl(r.totalCobrado)}</span>
    </div>
    <div class="progresso ${carrinho.length && r.falta <= 0 && pagamentos.length ? "completo" : ""}" aria-hidden="true"><span style="width:${pct}%"></span></div>
    ${status}
    <div class="totais"><span>Pago</span><span>${brl(r.pagoCobrado)}</span></div>
    ${desconto ? `<div class="totais"><span>Desconto</span><span>- ${brl(desconto)}</span></div>` : ""}
    ${r.mostrarOriginal ? `<div class="totais"><span>Valor original</span><span>${brl(r.valorOriginal)}</span></div>` : ""}
    ${r.mostrarReceber ? `<div class="totais"><span>Custo da loja (maquininha)</span><span>- ${brl(r.custoLojaTotal)}</span></div>` : ""}
    ${r.mostrarReceber ? `<div class="totais"><span>A loja recebe${r.estimadoReceber ? " (estimado)" : ""}</span><span>${brl(r.valorAReceber)}</span></div>` : ""}
    <div style="height:12px"></div>`;
}

// Zera a tela (sem perguntar nada). Usado depois de vender e pelo "Limpar".
function resetarVenda() {
  carrinho = [];
  pagamentos = [];
  $("#cliente").value = "";
  $("#cliente-contato").value = "";
  $("#observacoes").value = "";
  $("#cliente-perfil").value = "";
  aplicarClientePerfil();
  if ($("#indicador")) $("#indicador").value = "";
  $("#desconto").value = "0,00";
  renderResultados();
  renderCart();
  renderPags();
  renderTotais();
}

// Botao "Limpar". Cobranca na maquininha nao some sozinha: limpar a tela com
// dinheiro ja cobrado no cartao (ou uma cobranca aberta) deixaria um
// pagamento sem venda — entao estorna/cancela antes, ou nao deixa limpar.
async function limpar() {
  const aprovadas = pagamentos.filter((p) => p.point?.status === "processed");
  const pendentes = pagamentos.filter((p) => p.point && p.point.status !== "processed");

  if (aprovadas.length) {
    if (perfil.role !== "admin")
      return toast("Ha pagamento aprovado na maquininha neste carrinho. Finalize a venda ou peca a um administrador para estornar.", "err");
    const total = round2(aprovadas.reduce((s, p) => s + (p.point.valor_pago ?? p.valor), 0));
    const ok = await confirmar(
      `Ha ${aprovadas.length} pagamento(s) ja cobrado(s) na maquininha (${brl(total)}). Limpar vai ESTORNAR no cartao. Continuar?`,
      { textoConfirmar: "Estornar e limpar" }
    );
    if (!ok) return;
    try {
      for (const p of aprovadas) await clientePoint.estornar(p.point.cobrancaId);
    } catch (e) {
      return toast(e?.message || "Falha ao estornar. Nada foi limpo.", "err");
    }
  }

  for (const p of pendentes) {
    try {
      const { cobranca } = await clientePoint.cancelar(p.point.cobrancaId);
      if (cobranca?.status === "processed") {
        // Foi aprovada na maquininha no mesmo instante: o dinheiro JA foi cobrado.
        // Nao limpa (perderia o pagamento): a linha passa a "cobrada".
        marcarAprovada(p, cobranca);
        renderPags();
        renderTotais();
        return toast("Esse pagamento foi aprovado na maquininha antes de cancelar. Finalize a venda ou use Limpar de novo pra estornar.", "warn");
      }
      if (!cobranca?.final) throw new Error("A cobranca ainda esta aberta na maquininha. Cancele por la e tente de novo.");
    } catch (e) {
      // O MP so cancela pela API antes de a cobranca chegar na maquininha; depois, so por la.
      if (e?.codigo === "na_maquininha") {
        return toast("A cobranca esta aberta na maquininha e so da pra cancelar por la: aperte o X na maquininha e clique em Limpar de novo.", "err");
      }
      return toast(e?.message || "Nao foi possivel cancelar a cobranca em andamento.", "err");
    }
  }
  resetarVenda();
}

async function finalizar() {
  // Erro de preenchimento: avisa e leva o cursor pro campo.
  const erroEm = (sel, msg) => {
    toast(msg, "err");
    $(sel)?.focus();
  };
  if (!carrinho.length) return erroEm("#bipar", "A sacola está vazia. Bipe ou procure um produto.");
  if (!$("#cliente").value.trim()) return erroEm("#cliente", "Falta o nome do cliente.");
  if (!$("#cliente-contato").value.trim()) return erroEm("#cliente-contato", "Falta o contato do cliente (telefone ou WhatsApp).");
  const { subtotal, desconto, total, pago } = calc();
  if (total < 0) return erroEm("#desconto", "O desconto é maior que o subtotal da sacola.");
  if (!pagamentos.length) return toast("Escolha a forma de pagamento.", "err");
  if (round2(pago) !== total)
    return toast(`As formas de pagamento somam ${brl(pago)}, mas a venda é de ${brl(total)}. Ajuste os valores.`, "err");
  const clientePerfil = clienteSelecionado();
  const linhasCrediario = pagamentos.filter((p) => p.forma === "crediario" && p.valor > 0);
  if (linhasCrediario.length && !clientePerfil)
    return erroEm("#cliente-perfil", "Venda no crediário precisa de um cliente cadastrado. Escolha na lista ou toque em \"Novo\".");
  for (const p of linhasCrediario) {
    if ((p.entrada || 0) > dividaDoCrediario(pagamentosComJuros([p])[0]))
      return toast("O valor de parcela paga é maior que o valor no crediário.", "err");
  }
  const temDinheiro = pagamentos.some((p) => p.forma === "dinheiro" && p.valor > 0)
    || linhasCrediario.some((p) => (p.entrada || 0) > 0 && formaEntradaDe(p) === "dinheiro");
  if (temDinheiro && !caixaAbertoId)
    return toast("Abra o caixa antes de receber em dinheiro (tela Caixa).", "err");
  if (pagamentos.some((p) => p.point && p.point.status !== "processed"))
    return toast("Há cobrança em andamento na maquininha. Conclua ou cancele antes de finalizar.", "warn");
  // Com a exigencia ligada, cartao so entra na venda se passou pela maquininha
  // (senao da pra registrar "credito" sem cobrar nada).
  if (pointObrigatorio && pagamentos.some((p) => TIPO_POINT[p.forma] && p.valor > 0 && p.point?.status !== "processed"))
    return toast("Crédito e débito precisam ser cobrados na maquininha (botão \"Cobrar na maquininha\").", "err");

  const btn = $("#finalizar");
  btn.disabled = true;
  btn.classList.add("carregando");
  try {
    const itensVenda = carrinho.map((l) => ({
      produtoId: l.produtoId,
      sku: l.sku,
      codigoBarras: l.codigoBarras,
      nome: l.nome,
      qtd: l.qtd,
      preco_unit: round2(l.preco_unit),
      preco_custo: round2(l.preco_custo || 0),
      subtotal: round2(l.preco_unit * l.qtd),
    }));
    const comissao = calcularComissao({ itens: itensVenda, subtotal, total, config, perfil });
    const cliente = $("#cliente").value.trim() || null;
    const clienteContato = $("#cliente-contato").value.trim() || null;
    const observacoes = $("#observacoes").value.trim() || null;
    // So grava os campos quando ha indicador: venda sem indicador nao tem
    // `ref`, e a consulta `ref != ""` (comissao) nem a le.
    const indicador = indicadores.find((r) => r.id === $("#indicador")?.value) || null;
    const camposIndicador = indicador
      ? { ref: indicador.codigo, indicador_id: indicador.id, indicador_nome: indicador.nome || "" }
      : {};
    const pagamentosSalvos = pagamentosComJuros(pagamentos);
    const { totalComJuros, custoLojaTotal, valorLiquido } = agregarJuros(pagamentosSalvos);

    // Crediario: a divida inteira vai pro perfil do cliente e o que ele pagou
    // na hora vira um doc em `crediario_pagamentos` (e isso que o Caixa soma).
    const crediarioSalvo = pagamentosSalvos.filter((p) => p.forma === "crediario");
    const crediarioValor = round2(crediarioSalvo.reduce((s, p) => s + dividaDoCrediario(p), 0));
    const crediarioEntrada = round2(crediarioSalvo.reduce((s, p) => s + (p.entrada || 0), 0));
    const entradas = crediarioSalvo
      .filter((p) => p.entrada > 0)
      .map((p) => ({ ref: doc(collection(db, "crediario_pagamentos")), valor: p.entrada, forma: p.entrada_forma }));
    const vendaRef = doc(collection(db, "vendas"));
    const camposCliente = clientePerfil
      ? {
          cliente_id: clientePerfil.id,
          ...(crediarioValor > 0
            ? { crediario_valor: crediarioValor, crediario_entrada: crediarioEntrada, crediario_pagamento_ids: entradas.map((e) => e.ref.id) }
            : {}),
        }
      : {};

    const numero = await runTransaction(db, async (t) => {
      const contRef = doc(db, "contadores", "vendas");
      const contSnap = await t.get(contRef);
      const prox = (contSnap.exists() ? contSnap.data().ultimo_numero || 0 : 0) + 1;

      const clienteRef = clientePerfil ? doc(db, "clientes", clientePerfil.id) : null;
      if (clienteRef && !(await t.get(clienteRef)).exists())
        throw new Error("Cliente nao encontrado (foi excluido?). Recarregue a pagina.");

      const estoques = [];
      for (const it of itensVenda) {
        const ref = doc(db, "produtos", it.produtoId);
        const s = await t.get(ref);
        if (!s.exists()) throw new Error(`Produto ${it.nome} nao encontrado.`);
        const est = s.data().estoque ?? 0;
        if (est < it.qtd) throw new Error(`Estoque insuficiente de ${it.nome} (disponivel: ${est}).`);
        estoques.push({ ref, novo: est - it.qtd });
      }

      t.set(contRef, { ultimo_numero: prox }, { merge: true });
      // Regra do site: um vendedor so pode alterar `estoque`/`atualizadoEm`
      // em produtos — nada mais nesse update.
      estoques.forEach((e) =>
        t.update(e.ref, {
          estoque: e.novo,
          atualizadoEm: serverTimestamp(),
        })
      );
      if (clienteRef) {
        t.update(clienteRef, {
          ...(crediarioValor > 0 ? { total_compras: increment(crediarioValor), total_pago: increment(crediarioEntrada) } : {}),
          ultima_compra_em: serverTimestamp(),
          atualizado_em: serverTimestamp(),
        });
      }
      entradas.forEach((e) =>
        t.set(e.ref, {
          cliente_id: clientePerfil.id,
          cliente_nome: clientePerfil.nome || "",
          valor: e.valor,
          forma: e.forma,
          origem: "pdv",
          venda_id: vendaRef.id,
          venda_numero: prox,
          caixa_id: caixaAbertoId || null,
          data: serverTimestamp(),
          registrado_por_uid: perfil.id,
          registrado_por_nome: perfil.nome || "",
          status: "ok",
        })
      );
      t.set(vendaRef, {
        numero: prox,
        canal: "loja",
        data: serverTimestamp(),
        criado_em: serverTimestamp(),
        vendedor_uid: perfil.id,
        vendedor_nome: perfil.nome || "",
        cliente,
        cliente_contato: clienteContato,
        observacoes,
        ...camposIndicador,
        ...camposCliente,
        itens: itensVenda,
        subtotal,
        desconto,
        total,
        total_com_juros: totalComJuros,
        custo_loja_total: custoLojaTotal,
        valor_liquido: valorLiquido,
        pagamentos: pagamentosSalvos,
        status: "concluida",
        caixa_id: caixaAbertoId || null,
        comissao,
      });
      return prox;
    });

    toast(`Venda #${numero} registrada. Recibo aberto em outra janela.`, "ok");
    recibo({ numero, itens: itensVenda, subtotal, desconto, total, totalComJuros, pagamentos: pagamentosSalvos, cliente, clienteContato, observacoes });
    if (clientePerfil && crediarioValor > 0) {
      clientePerfil.total_compras = round2((clientePerfil.total_compras || 0) + crediarioValor);
      clientePerfil.total_pago = round2((clientePerfil.total_pago || 0) + crediarioEntrada);
    }

    // atualiza estoque em memoria
    itensVenda.forEach((it) => {
      const p = produtos.find((x) => x.id === it.produtoId);
      if (p) p.estoque = estoqueDe(p) - it.qtd;
    });
    invalidarCatalogo(); // estoque mudou: as outras telas desta aba releem
    resetarVenda();
  } catch (e) {
    toast(e?.message || "Falha ao registrar venda.", "err");
  } finally {
    btn.disabled = false;
    btn.classList.remove("carregando");
  }
}

function recibo(v) {
  const w = window.open("", "_blank", "width=360,height=640");
  if (!w) return;
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Venda #${v.numero}</title>
  <body style="font-family:system-ui;padding:16px;font-size:13px;color:#2b2430">
    <h3 style="margin:0">${escapeHtml(config.nome_loja || "Amira")}</h3>
    <div>Venda #${v.numero} &mdash; ${new Date().toLocaleString("pt-BR")}</div>
    <div>Vendedor: ${escapeHtml(perfil.nome || "")}</div>
    ${v.cliente ? `<div>Cliente: ${escapeHtml(v.cliente)}</div>` : ""}
    ${v.clienteContato ? `<div>Contato: ${escapeHtml(v.clienteContato)}</div>` : ""}
    ${v.observacoes ? `<div>Obs: ${escapeHtml(v.observacoes)}</div>` : ""}
    <hr>
    <table style="width:100%;border-collapse:collapse">
      ${v.itens
        .map(
          (it) =>
            `<tr><td>${it.qtd}x ${escapeHtml(it.nome)}</td><td style="text-align:right">${brl(it.subtotal)}</td></tr>`
        )
        .join("")}
    </table>
    <hr>
    <div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>${brl(v.subtotal)}</span></div>
    <div style="display:flex;justify-content:space-between"><span>Desconto</span><span>- ${brl(v.desconto)}</span></div>
    <div style="display:flex;justify-content:space-between;font-weight:700"><span>Total</span><span>${brl(v.total)}</span></div>
    ${v.totalComJuros && v.totalComJuros !== v.total ? `<div style="display:flex;justify-content:space-between;font-weight:700"><span>Total com juros</span><span>${brl(v.totalComJuros)}</span></div>` : ""}
    ${v.pagamentos
      .map(
        (p) =>
          `<div style="display:flex;justify-content:space-between"><span>${p.forma}${p.parcelas > 1 ? ` (${p.parcelas}x de ${brl(p.valor_parcela)})` : ""}</span><span>${brl(p.valor_com_juros ?? p.valor)}</span></div>`
      )
      .join("")}
    ${v.pagamentos
      .filter((p) => p.forma === "crediario")
      .map(
        (p) =>
          `<div style="display:flex;justify-content:space-between"><span>Pago agora (${p.entrada_forma})</span><span>${brl(p.entrada)}</span></div>
           <div style="display:flex;justify-content:space-between;font-weight:700"><span>Fica no crediario</span><span>${brl(p.saldo_devedor)}</span></div>`
      )
      .join("")}
    <hr>
    <div style="text-align:center">Obrigada pela preferencia!</div>
    <button onclick="window.print()" style="margin-top:12px;width:100%;padding:8px">Imprimir</button>
  </body>`);
  w.document.close();
}
} catch (e) {
  erroCard(root, e);
}
