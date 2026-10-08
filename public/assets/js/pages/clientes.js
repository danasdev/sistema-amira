import { requireAuth } from "../auth.js";
import { initShell, toast, modal, confirmar, escapeHtml, fmtData, erroCard, tituloCard, vazio } from "../ui.js";
import { icone } from "../icons.js";
import {
  db, collection, getDocs, query, where,
  doc, runTransaction, serverTimestamp, increment, getConfigSistema,
} from "../db.js";
import { brl, round2, parseNum, valorCampo } from "../money.js";
import { saldoCliente } from "../crediario.js";
import { listarClientes, editarCliente } from "../clientes.js";

// Clientes do crediario: a "comanda" de cada um — compras no crediario,
// pagamentos (o pago na hora no PDV + os lancados aqui), total, pago e
// restante. Pagamento lancado aqui entra no caixa aberto (dinheiro exige
// caixa aberto, igual ao PDV). So admin estorna um lancamento errado.

const { perfil } = await requireAuth();
const ehAdm = perfil.role === "admin";
const root = initShell({ perfil, active: "clientes" });

const ROTULO_FORMA = { dinheiro: "Dinheiro", pix: "Pix", debito: "Débito", credito: "Crédito", crediario: "Crediário" };
let clientes = [];
let formasPagamento = [];
let busca = "";

render();

async function render() {
  root.innerHTML = `<div class="card">Carregando...</div>`;
  try {
    const [lista, config] = await Promise.all([listarClientes(), getConfigSistema()]);
    clientes = lista;
    formasPagamento = (config.formas_pagamento?.length ? config.formas_pagamento : ["dinheiro", "pix", "debito", "credito"])
      .filter((f) => f !== "crediario");
    renderLista();
  } catch (e) {
    erroCard(root, e, render);
  }
}

function renderLista() {
  const totalAberto = round2(clientes.reduce((s, c) => s + Math.max(0, saldoCliente(c).restante), 0));
  const devendo = clientes.filter((c) => saldoCliente(c).restante > 0).length;
  root.innerHTML = `
    <div class="card">
      <div class="grid cols-3">
        <div class="kpi"><div class="l">${icone("clientes", { tam: 16 })}Clientes cadastrados</div><div class="n">${clientes.length}</div></div>
        <div class="kpi"><div class="l">${icone("aviso", { tam: 16 })}Com conta em aberto</div><div class="n">${devendo}</div></div>
        <div class="kpi" style="background:var(--ouro-claro);border-color:#e6d3ac"><div class="l">${icone("crediario", { tam: 16 })}Total a receber no crediário</div><div class="n">${brl(totalAberto)}</div></div>
      </div>
      <div class="row" style="align-items:center;margin-top:16px">
        <div class="campo-ic">${icone("busca", { tam: 18 })}<input id="busca" placeholder="Buscar por nome, contato ou CPF" value="${escapeHtml(busca)}" autocomplete="off"></div>
        <button class="btn" id="novo" style="flex:0 0 auto">${icone("novoUsuario", { tam: 16 })}Novo cliente</button>
      </div>
    </div>
    <div class="card"><div id="tabela"></div></div>`;
  root.querySelector("#novo").onclick = () => editarCliente(null, { perfil, onSalvo: () => render() });
  root.querySelector("#busca").oninput = (e) => {
    busca = e.target.value;
    renderTabela();
  };
  renderTabela();
}

function renderTabela() {
  const termo = busca.toLowerCase().trim();
  const lista = clientes.filter(
    (c) => !termo || [c.nome, c.contato, c.cpf].some((x) => (x || "").toLowerCase().includes(termo))
  );
  const box = root.querySelector("#tabela");
  box.innerHTML = `
    <div class="tabela-wrap"><table>
      <thead><tr>
        <th>Nome</th><th>Contato</th><th class="right">Compras</th><th class="right">Pago</th>
        <th class="right">Restante</th><th>Ultima compra</th><th></th>
      </tr></thead>
      <tbody>
        ${
          lista
            .map((c) => {
              const s = saldoCliente(c);
              return `<tr>
                <td><a href="#" class="ver" data-id="${c.id}">${escapeHtml(c.nome || "-")}</a></td>
                <td>${escapeHtml(c.contato || "")}</td>
                <td class="right">${brl(s.compras)}</td>
                <td class="right">${brl(s.pago)}</td>
                <td class="right">${s.restante > 0 ? `<strong style="color:var(--vinho)">${brl(s.restante)}</strong>` : s.compras > 0 ? `<span class="tag ok">quitado</span>` : `<span class="muted">sem compras</span>`}</td>
                <td>${fmtData(c.ultima_compra_em)}</td>
                <td class="right" style="white-space:nowrap">
                  <button class="btn ghost ver" data-id="${c.id}">${icone("nota", { tam: 15 })}Comanda</button>
                  <button class="btn sec pagar" data-id="${c.id}" ${s.restante > 0 ? "" : "disabled"}>${icone("dinheiro", { tam: 15 })}Receber</button>
                </td>
              </tr>`;
            })
            .join("") || `<tr><td colspan="7">${termo ? vazio("busca", "Nenhum cliente encontrado", "Confira o nome, o telefone ou o CPF.") : vazio("clientes", "Nenhum cliente cadastrado ainda", "Clientes entram aqui ao vender no crediário pelo PDV, ou pelo botão \"Novo cliente\".")}</td></tr>`
        }
      </tbody>
    </table></div>`;
  const achar = (id) => clientes.find((c) => c.id === id);
  box.querySelectorAll(".ver").forEach((b) => (b.onclick = (e) => {
    e.preventDefault();
    verCliente(achar(b.dataset.id));
  }));
  box.querySelectorAll(".pagar").forEach((b) => (b.onclick = () => lancarPagamento(achar(b.dataset.id), render)));
}

// ── Perfil / comanda ─────────────────────────────────────────────────────
async function verCliente(c) {
  root.innerHTML = `<div class="card">Carregando...</div>`;
  try {
    const [vendasSnap, pagsSnap] = await Promise.all([
      getDocs(query(collection(db, "vendas"), where("cliente_id", "==", c.id))),
      getDocs(query(collection(db, "crediario_pagamentos"), where("cliente_id", "==", c.id))),
    ]);
    const millis = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0);
    const recentes = (a, b) => millis(b.data) - millis(a.data);
    const vendas = vendasSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(recentes);
    const pagamentos = pagsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(recentes);
    renderPerfil(c, vendas, pagamentos);
  } catch (e) {
    erroCard(root, e, () => verCliente(c));
  }
}

function renderPerfil(c, vendas, pagamentos) {
  const s = saldoCliente(c);
  root.innerHTML = `
    <div class="card">
      <button class="btn ghost" id="voltar" style="margin-bottom:12px">${icone("voltar", { tam: 16 })}Todos os clientes</button>
      <div class="row" style="align-items:center">
        <div style="min-width:220px"><h2 style="margin:0;font-size:26px">${escapeHtml(c.nome || "-")}</h2></div>
        <button class="btn ghost" id="editar" style="flex:0 0 auto">${icone("editar", { tam: 16 })}Editar dados</button>
        <button class="btn" id="pagar" style="flex:0 0 auto" ${s.restante > 0 ? "" : "disabled"}>${icone("dinheiro", { tam: 16 })}Lançar pagamento</button>
      </div>
      <p class="muted" style="margin-top:8px">
        ${escapeHtml(c.contato || "-")}
        ${c.cpf ? ` &middot; CPF ${escapeHtml(c.cpf)}` : ""}
        ${c.endereco ? ` &middot; ${escapeHtml(c.endereco)}` : ""}
        &middot; cliente desde ${fmtData(c.criado_em)}
      </p>
      ${c.observacoes ? `<p class="muted">Obs: ${escapeHtml(c.observacoes)}</p>` : ""}
      <div class="grid cols-3" style="margin-top:12px">
        <div class="kpi"><div class="l">${icone("sacola", { tam: 16 })}Total comprado no crediário</div><div class="n">${brl(s.compras)}</div></div>
        <div class="kpi"><div class="l">${icone("sucesso", { tam: 16 })}Já pagou</div><div class="n">${brl(s.pago)}</div></div>
        <div class="kpi" style="background:var(--ouro-claro);border-color:#e6d3ac"><div class="l">${icone("crediario", { tam: 16 })}Falta pagar</div><div class="n">${brl(s.restante)}</div></div>
      </div>
      ${s.compras > 0 ? `<div class="progresso ${s.restante <= 0 ? "completo" : ""}" style="margin-top:14px" title="${Math.round((s.pago / s.compras) * 100)}% pago"><span style="width:${Math.min(100, (s.pago / s.compras) * 100)}%"></span></div>
      <p class="dica">${Math.round(Math.min(100, (s.pago / s.compras) * 100))}% da conta já foi paga.</p>` : ""}
      ${s.restante < 0 ? `<p class="muted" style="margin-top:8px">O cliente tem ${brl(-s.restante)} de credito (pagou mais do que deve, ex.: venda cancelada depois de paga).</p>` : ""}
    </div>

    <div class="card">
      ${tituloCard("sacola", "Compras")}
      <div class="tabela-wrap"><table>
        <thead><tr><th>#</th><th>Data</th><th>Itens</th><th class="right">Total</th><th class="right">No crediario</th><th class="right">Pago na hora</th><th>Status</th></tr></thead>
        <tbody>
          ${
            vendas
              .map(
                (v) => `<tr>
                  <td>${v.numero ?? "-"}</td>
                  <td>${fmtData(v.data)}</td>
                  <td>${(v.itens || []).map((it) => `${it.qtd}x ${escapeHtml(it.nome)}`).join("<br>")}</td>
                  <td class="right">${brl(v.total)}</td>
                  <td class="right">${v.crediario_valor ? brl(v.crediario_valor) : "-"}</td>
                  <td class="right">${v.crediario_valor ? brl(v.crediario_entrada || 0) : "-"}</td>
                  <td><span class="tag ${v.status}">${v.status}</span></td>
                </tr>`
              )
              .join("") || `<tr><td colspan="7">${vazio("sacola", "Nenhuma compra ainda", "As compras aparecem quando o cliente é escolhido no PDV.")}</td></tr>`
          }
        </tbody>
      </table></div>
    </div>

    <div class="card">
      ${tituloCard("dinheiro", "Pagamentos")}
      <div class="tabela-wrap"><table>
        <thead><tr><th>Data</th><th>Origem</th><th>Forma</th><th>Registrado por</th><th class="right">Valor</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${
            pagamentos
              .map(
                (p) => `<tr>
                  <td>${fmtData(p.data)}</td>
                  <td>${p.origem === "pdv" ? `Pago na venda #${p.venda_numero ?? "-"}` : "Lançamento"}${p.observacoes ? `<div class="muted">${escapeHtml(p.observacoes)}</div>` : ""}</td>
                  <td>${escapeHtml(ROTULO_FORMA[p.forma] || p.forma || "-")}</td>
                  <td>${escapeHtml(p.registrado_por_nome || "-")}</td>
                  <td class="right">${brl(p.valor)}</td>
                  <td><span class="tag ${p.status === "estornado" ? "cancelada" : "concluida"}">${p.status === "estornado" ? "estornado" : "ok"}</span></td>
                  <td class="right">${ehAdm && p.origem === "lancamento" && p.status !== "estornado" ? `<button class="btn ghost estornar" data-id="${p.id}">Estornar</button>` : ""}</td>
                </tr>`
              )
              .join("") || `<tr><td colspan="7">${vazio("dinheiro", "Nenhum pagamento ainda", "Use \"Lançar pagamento\" quando o cliente pagar uma parte da conta.")}</td></tr>`
          }
        </tbody>
      </table></div>
      <p class="muted" style="margin-top:8px">Pago na hora de uma venda so e estornado cancelando a venda (tela Vendas).</p>
    </div>`;

  const recarregar = () => verCliente(c);
  root.querySelector("#voltar").onclick = () => renderLista();
  root.querySelector("#editar").onclick = () => editarCliente(c, { perfil, onSalvo: recarregar });
  root.querySelector("#pagar").onclick = () => lancarPagamento(c, recarregar);
  root.querySelectorAll(".estornar").forEach(
    (b) => (b.onclick = () => estornar(c, pagamentos.find((p) => p.id === b.dataset.id), recarregar))
  );
}

// ── Lancar / estornar pagamento ──────────────────────────────────────────
async function caixaAbertoId() {
  const s = (await getDocs(query(collection(db, "caixa"), where("status", "==", "aberto")))).docs[0];
  return s ? s.id : null;
}

function lancarPagamento(c, depois) {
  const { restante } = saldoCliente(c);
  const corpo = document.createElement("div");
  corpo.innerHTML = `
    <div class="kpi" style="background:var(--ouro-claro);border:1px solid #e6d3ac;border-radius:var(--r-sm);padding:12px 16px">
      <div class="l" style="min-height:0">${icone("crediario", { tam: 16 })}${escapeHtml(c.nome)} deve</div><div class="n">${brl(restante)}</div>
    </div>
    <label for="pg-valor">Quanto o cliente pagou agora?</label>
    <div class="row" style="gap:8px;flex-wrap:nowrap">
      <div class="campo-rs"><input id="pg-valor" inputmode="decimal" value="0,00"></div>
      <button type="button" class="btn ghost" id="pg-tudo" style="flex:0 0 auto">Quitar tudo</button>
    </div>
    <label for="pg-forma">Pagou em</label>
    <select id="pg-forma">${formasPagamento.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(ROTULO_FORMA[f] || f)}</option>`).join("")}</select>
    <p class="dica">O valor entra no caixa aberto. Em dinheiro, o caixa precisa estar aberto.</p>
    <label for="pg-obs">Observação <span class="opc">(opcional)</span></label><input id="pg-obs" placeholder="Ex.: parcela de outubro">`;
  corpo.querySelector("#pg-tudo").onclick = () => (corpo.querySelector("#pg-valor").value = valorCampo(restante));
  modal({
    titulo: "Lançar pagamento",
    corpo,
    textoConfirmar: "Registrar pagamento",
    onConfirmar: async () => {
      const valor = round2(parseNum(corpo.querySelector("#pg-valor").value));
      const forma = corpo.querySelector("#pg-forma").value;
      const observacoes = corpo.querySelector("#pg-obs").value.trim();
      if (valor <= 0) {
        toast("Informe quanto o cliente pagou.", "err");
        return false;
      }
      const caixaId = await caixaAbertoId();
      if (forma === "dinheiro" && !caixaId) {
        toast("Abra o caixa antes de receber em dinheiro (tela Caixa).", "err");
        return false;
      }
      const clienteRef = doc(db, "clientes", c.id);
      const pagRef = doc(collection(db, "crediario_pagamentos"));
      await runTransaction(db, async (t) => {
        const snap = await t.get(clienteRef);
        if (!snap.exists()) throw new Error("Cliente nao encontrado.");
        const atual = saldoCliente(snap.data()).restante;
        if (valor > atual) throw new Error(`O valor e maior que o restante (${brl(atual)}).`);
        t.set(pagRef, {
          cliente_id: c.id,
          cliente_nome: c.nome || "",
          valor,
          forma,
          origem: "lancamento",
          caixa_id: caixaId,
          data: serverTimestamp(),
          registrado_por_uid: perfil.id,
          registrado_por_nome: perfil.nome || "",
          status: "ok",
          ...(observacoes ? { observacoes } : {}),
        });
        t.update(clienteRef, { total_pago: increment(valor), atualizado_em: serverTimestamp() });
      });
      c.total_pago = round2((c.total_pago || 0) + valor);
      toast(`Pagamento de ${brl(valor)} registrado${caixaId ? " e lançado no caixa" : " (sem caixa aberto)"}.`, "ok");
      depois?.();
    },
  });
}

async function estornar(c, p, depois) {
  if (!p) return;
  if (!(await confirmar(`Estornar o pagamento de ${brl(p.valor)} (${p.forma})? O valor volta pra divida do cliente.`, { textoConfirmar: "Estornar" }))) return;
  try {
    const pagRef = doc(db, "crediario_pagamentos", p.id);
    await runTransaction(db, async (t) => {
      const snap = await t.get(pagRef);
      if (!snap.exists() || snap.data().status === "estornado") throw new Error("Pagamento ja estornado.");
      t.update(pagRef, { status: "estornado", estornado_em: serverTimestamp(), estornado_por_uid: perfil.id });
      t.update(doc(db, "clientes", c.id), { total_pago: increment(-p.valor), atualizado_em: serverTimestamp() });
    });
    c.total_pago = round2((c.total_pago || 0) - p.valor);
    toast("Pagamento estornado.", "ok");
    depois?.();
  } catch (e) {
    toast(e?.message || "Falha ao estornar.", "err");
  }
}
