# Sistema interno Amira

Sistema de gestao da perfumaria Amira: login de ADM e vendedor, PDV com leitor de
codigo de barras, caixa diario, comissionamento, cadastro de produtos, apuracao de
indicadores (link `?ref=` do site) e painel. Fases futuras: consumir os pedidos do
site proprio, Mercado Livre, Shopee e conciliacao com o Mercado Pago.

**Stack:** HTML + CSS + JavaScript puro (ES modules), Firebase Web SDK **10.12.5**
(Auth + Firestore), Firebase Hosting. Scripts Python (`firebase-admin`) para bootstrap,
importacao de catalogo, relatorios e backup.

Roda **100% no plano gratuito (Spark)** do Firebase. **Nenhuma Cloud Function.** Toda
automacao e script Python + GitHub Actions (cron). A unica parte com backend e a
integracao **opcional** da maquininha Mercado Pago Point (secao 10): funcoes serverless na
**Vercel** (`api/`), fora do Firebase. Desligada por padrao — sem ela o sistema funciona
exatamente como antes.

---

## 0. Unificacao com o site (importante)

Desde 2026-09 o sistema **compartilha o projeto Firebase do site** (`flora-5754a`) e o
**mesmo catalogo `produtos`**. Consequencias:

| Tema | Como e |
|---|---|
| Projeto Firebase | `flora-5754a` (o mesmo do site). O sistema e um **app separado** neste repo, publicado num alvo de Hosting proprio (`interno` -> `https://flora-5754a-interno.web.app`). |
| Regras e indices | `firestore.rules` e `firestore.indexes.json` **deste repo sao os canonicos** (cobrem site + sistema). **Deploy de regras/indices sai daqui, nunca do repo do site.** O repo do site guarda uma copia **identica** dos dois arquivos: ao mudar aqui, copie os dois para o site no mesmo dia (e ao receber mudanca vinda do site, compare campo por campo antes de aceitar). |
| Papel de admin | `role: "admin"` no doc `usuarios/{uid}` (igual ao site). O outro papel e `role: "vendedor"`. |
| Schema de produto | E o schema do SITE: `codigoBarras`, `precoVarejo`/`precoAtacado` (dois valores), `estoque` (um so, sem separacao varejo/atacado), `filtros{}` por camada, `ativo`, `descontoAtivo`/`descontoPercentual`, etc. Ver secao 8. |
| "Indicador" x "Revendedor" | Aqui, **indicador** = divulgador com link `?ref=` (colecao `indicadores`, sem login). No site, "revendedor" e outra coisa: comprador atacado com CNPJ (`usuarios.tipoConta == "revendedor"`). Nao confundir. |
| Vendas do site | Ficam na colecao `pedidos` (criada pelo cliente no site, **sem valores monetarios** por design). O sistema **le e deriva** os totais do catalogo. Nao gravamos `pedidos` com preco e o checkout do site **nao** grava em `vendas`. |
| App Check | O site tem App Check (reCAPTCHA v3) mas hoje **desligado** (chave placeholder). Quando ligar o Enforce, este app precisa registrar o proprio App Check no dominio `flora-5754a-interno`. |

---

## 1. O que ja esta pronto

| Modulo | Papel | Descricao |
|---|---|---|
| Login / guarda de rota | — | Firebase Auth (e-mail/senha). So `admin` ou `vendedor` ativo entram; cliente do site que tentar logar e deslogado no submit com aviso. |
| Painel (`dashboard`) | admin + vendedor | Vendas do dia, faturamento, ticket medio, comissao do mes, caixa aberto (unico pra loja toda), vendas por canal, top produtos. Vendedor ve so os proprios numeros de venda; comissao e caixa sao compartilhados. **Admin** ve tambem "Contabilidade mensal" (receita bruta, juros, gastos, comissao de vendedores e de indicadores, valor liquido do mes — por periodo escolhido). |
| PDV (`pdv`) | admin + vendedor | **Leitor USB de codigo de barras** (bipa `codigoBarras` -> carrinho) + busca por nome. Preco via `infoPreco`, estoque via `estoquePorModo` (pool unico, sem separacao varejo/atacado). Carrinho, cliente/contato obrigatorios, desconto, formas de pagamento com **juros reais** por parcela (cliente/loja, ver `juros.js`), baixa de `estoque`, calculo de comissao e vinculo ao caixa **unico/compartilhado** — tudo numa transacao. Recibo para impressao ja com o valor cobrado do cliente. |
| Caixa (`caixa`) | admin + vendedor | Caixa **unico pra loja toda** (nao "do usuario") — so pode haver um aberto por vez, qualquer staff opera nele (abre, lanca sangria/suprimento, fecha), conferencia soma vendas de toda a equipe. Fechamento com conferencia de dinheiro e divergencia, historico compartilhado. Mostra os gastos lancados no periodo pra qualquer staff; **admin** ve tambem o card "Valor liquido do caixa" (vendido − custo de maquininha − gastos), sem alterar o calculo de dinheiro na gaveta. **Parcelado nao entra inteiro:** credito parcelado conta so uma parcela e crediario so o que foi pago (na venda ou lancado em Clientes) — ver `crediario.js`. |
| Vendas (`vendas`) | admin + vendedor | Historico com filtro por canal e por forma de pagamento. Admin pode cancelar venda (devolve `estoque` em transacao). Vendedor ve as proprias vendas de loja + o espelho de pedidos do site. |
| Comissoes (`comissoes`) | admin + vendedor | Relatorio por vendedor/periodo (so canal `loja`), fechamento de periodo e marcacao de pago. |
| Gastos (`gastos`) | **so admin** | CRUD de despesas soltas por data (`descricao, categoria, valor, data, observacoes`) — nao depende de caixa aberto. Leitura do resumo do periodo liberada pra qualquer staff dentro do Caixa. |
| Produtos (`produtos`) | **so admin** | Editor completo no schema do site: `codigoBarras` (EAN) obrigatorio e unico, `filtros{}` por camada + categoria legado, precos varejo/atacado, estoques, desconto, `ativo`/`destaque`/`freteDisponivel`; fotos por URL. Acao em massa ativar/inativar. |
| Clientes (`clientes`) | admin + vendedor | Clientes do **crediario** (colecao `clientes`, nao e o cliente do site). Venda no crediario exige cliente cadastrado (da pra criar na hora no PDV). Cada cliente tem a "comanda": compras, total da divida, pago, restante e pagamentos; qualquer staff lanca pagamento (vai pro caixa aberto, colecao `crediario_pagamentos`), so admin estorna. No PDV, "valor de parcela paga" e o que entra no caixa; o resto vira divida. |
| Indicadores (`indicadores`) | **so admin** | CRUD de indicadores (`nome, codigo, contato, ativo, anotacoes`), copia do link `?ref=`, e **apuracao por periodo venda por venda** (sem resumo agregado — o resumo fica no "Perfil" de cada indicador): le `pedidos` com `ref`, deriva a base elegivel do catalogo atual (`camadas` + `produtos`), exclui iPhone, aplica o percentual. Pagamento manual. |
| Usuarios (`usuarios`) | **so admin** | Cria vendedor **sem deslogar o admin** (instancia secundaria do Firebase App so para o `createUserWithEmailAndPassword`; o doc `usuarios/{uid}` e gravado pela instancia primaria). Define `%`/base de comissao, ativa/inativa. |
| Configuracoes (`config`) | **so admin** | `configuracoes/sistema` (nome da loja, CNPJ, formas de pagamento, tabela de juros por forma, base + `%` padrao de comissao) e `configuracoes/indicadores` (`site_url`, `percentual`, `janela_dias`, `categorias_excluidas[]`). |
| Maquininha (Point) | admin + vendedor (config: admin) | **Opcional, em teste.** Credito/debito cobrados direto na maquininha Mercado Pago Point pelo PDV, com a taxa REAL de cada venda. Ver secao 10. |
| Backup | — | GitHub Action diaria exporta o Firestore para JSON (artefato de 30 dias). |

### Estado (2026-09)

- Regras, indices e Hosting **ja publicados** em `flora-5754a`. URL:
  `https://flora-5754a-interno.web.app`.
- Testado de verdade pela primeira vez em 05/09; bugs de permissao do Firestore
  (abrir caixa, query de vendas do vendedor, cliente do site logando) corrigidos e
  redeployados. Todas as telas de carregamento tem `try/catch` + cartao de erro com
  "Tentar de novo".
- Tema repaletado para **bordo/vinho** (marca da loja) e logo da Amira na sidebar.

### Fases seguintes (nao implementadas)

- **Fase 2 — pedidos do site:** telas no sistema para listar/gerir os `pedidos` do
  site (o site ja captura `?ref=` e grava `ref` no pedido). Ver `FASE2.md`.
- **Fase 3 — Mercado Livre** e **Fase 4 — Shopee:** exigem um backend hospedado fora
  do Spark (ex.: Render free) para OAuth + webhook. Sem app de desenvolvedor ainda.
- **Mercado Pago:** conciliacao real via API — tambem exige backend externo.

---

## 2. Pre-requisitos

- Node.js 18+ e o Firebase CLI (`npm install -g firebase-tools`, ou `npx firebase-tools`).
- Python 3.11+.
- Acesso a conta Google com permissao no projeto `flora-5754a`.

---

## 3. Configurar (uma vez)

1. `public/assets/js/firebase-config.js` — ja contem as credenciais publicas reais do
   `flora-5754a`. So mexer se o app da Web for recriado no Console.
2. `.firebaserc` — ja aponta para `flora-5754a` com o target de Hosting `interno`
   (`flora-5754a-interno`).
3. `serviceAccount.json` na raiz — chave privada (Console > Configuracoes do projeto >
   Contas de servico). Esta no `.gitignore`; **nao versionar**.
4. No Console do `flora-5754a`: **Authentication > Sign-in method** com **E-mail/senha**
   habilitado; **Firestore** ja existe (e o do site).

---

## 4. Publicar

```bash
firebase login   # ou: npx firebase-tools login

# regras + indices — CANONICO, so a partir DESTE repo, junto com o deploy do site
firebase deploy --only firestore:rules,firestore:indexes

# front-end do sistema (nao afeta o site)
firebase deploy --only hosting:interno
```

> O Console pode oferecer um link "criar indice" na primeira vez que uma tela roda
> uma query composta nova — basta clicar.

---

## 5. Criar o primeiro admin

```bash
cd scripts
python -m venv .venv && source .venv/bin/activate      # opcional
pip install -r requirements.txt
export GOOGLE_APPLICATION_CREDENTIALS=../serviceAccount.json

python bootstrap_admin.py --email "dono@amira.com" --senha "trocar-depois" --nome "Dono"
```

Cria o usuario no Auth, o doc `usuarios/{uid}` com `role: "admin"` e os docs
`configuracoes/sistema` e `configuracoes/indicadores` padrao. Depois e so acessar
`https://flora-5754a-interno.web.app` e logar.

---

## 6. Uso no dia a dia

- **Admin** cria os vendedores em **Usuarios** (senha provisoria; redefinir depois no
  Console ou via "Esqueci a senha", se habilitado).
- **Configuracoes**: base da comissao (`total`, `total_sem_desconto` ou `margem`) e o
  `%` padrao. Cada vendedor pode ter override em **Usuarios**. Obs.: base `margem` fica
  0 enquanto o catalogo do site nao tiver campo de custo.
- **Vendedor** abre o **Caixa** no inicio do dia, vende no **PDV**, fecha o caixa
  conferindo o dinheiro no fim do dia.
- **Comissoes**: no fim do mes o admin fecha o periodo por vendedor e marca como pago.
- **Indicadores**: o admin apura o periodo, exporta e paga manualmente.

### Scripts

```bash
# importar / atualizar catalogo (CSV ou XLSX) — upsert por codigoBarras, schema do site
python scripts/importar_produtos.py --arquivo scripts/exemplo_produtos.csv

# comissoes de vendedores do mes -> XLSX
python scripts/relatorio_comissoes.py --periodo 2026-09

# comissoes dos indicadores (link ?ref= do site) -> XLSX
python scripts/relatorio_indicadores.py --periodo 2026-09

# backup manual do Firestore
python scripts/backup_firestore.py --dir backups

# backfill de custo_loja/valor_liquido em vendas ANTIGAS (antes dos juros reais)
# por padrao so mostra relatorio; use --aplicar pra gravar de verdade
python scripts/backfill_juros_historico.py
python scripts/backfill_juros_historico.py --aplicar

# backfill de pagamento.parcelas (site) nos espelhos ja existentes em vendas
python scripts/backfill_parcelas_pedidos_site.py
python scripts/backfill_parcelas_pedidos_site.py --aplicar

# conciliacao da maquininha (so leitura): cobranca aprovada sem venda, pendencias
# travadas, estornos em venda concluida, taxa real x estimada
python scripts/conciliar_point.py
python scripts/conciliar_point.py --desde 2026-09-01

# maquininha: confere se da pra cobrar (token do MP, Firebase, terminal, modo PDV).
# Nao cobra nada. --gravar guarda o id do terminal no .env; --colocar-pdv poe em modo PDV
npm run point:check
npm run point:check -- --gravar --colocar-pdv

# API da maquininha rodando NO SEU COMPUTADOR (mesmas funcoes da Vercel; le o .env)
npm run api:dev

# servidor estatico local para abrir o front sem deploy
python scripts/dev_server.py

# testes da API e dos scripts da maquininha (Node 22+, sem rede nem credencial)
npm install && npm test
```

### Backup automatico (GitHub Actions)

Se versionar no GitHub, adicione o secret `FIREBASE_SERVICE_ACCOUNT` (conteudo do
`serviceAccount.json`) em **Settings > Secrets and variables > Actions**. O workflow
`.github/workflows/backup.yml` roda diariamente e guarda o backup como artefato (30 dias).

---

## 7. Estrutura

```
public/                       front-end (deploy no Hosting, target "interno")
  *.html                      uma pagina por modulo
  assets/css/base.css         estilo unico (paleta bordo/vinho)
  assets/img/amira-logo.png   logo da sidebar
  assets/js/
    firebase-config.js        credenciais publicas do flora-5754a
    firebase.js               init do SDK (10.12.5)
    auth.js                   login, guarda de rota (ehEquipe), criar vendedor
    db.js                     re-export do Firestore + helpers de data/config
    ui.js                     shell (menu), toast, modal, erroCard
    money.js                  formatacao/arredondamento
    regras.js                 calculo de comissao de vendedor
    produtos-schema.js        helpers portados do site (infoPreco, estoquePorModo,
                              slugEhIphone, baseElegivelIndicador, ...)
    camadas.js                servico de camadas (filtros do catalogo)
    juros.js                  juros de parcelamento (tabela cliente/loja, infoParcela)
    point.js                  maquininha: cliente da API, polling, mapeamento pra venda (puro)
    point-ui.js               maquininha: modal de cobranca
    pages/*.js                logica de cada tela
api/                          funcoes serverless (Vercel) — SO a maquininha Point
  point/*.js, webhook-point.js  rotas (finas; a logica esta em _lib/point-handlers.js)
  _lib/                       Firestore Admin, cliente Mercado Pago, regras puras, auth, CORS
tests/                        testes da API, do cliente e dos scripts da maquininha (node --test)
package.json, vercel.json     dependencias e build das funcoes (Vercel)
.env.example                  variaveis de ambiente da API (na Vercel ou no .env local; nunca commitar valores)
scripts/                      ferramentas Python (firebase-admin) + teste local da maquininha em Node
  api-dev.mjs, point-check.mjs, lib/env.mjs   npm run api:dev / npm run point:check
firestore.rules               CANONICO (site + sistema)
firestore.indexes.json        CANONICO
firebase.json                 Hosting (target "interno") + Firestore
.firebaserc                   projeto flora-5754a + target interno
```

---

## 8. Modelo de dados (Firestore)

Colecoes **do sistema**:

- `usuarios/{uid}`: `nome, email, role ("admin"|"vendedor"), ativo, comissao{ base?, percentual? }`
  (o mesmo doc que o site usa para clientes; papel de equipe so o admin grava).
- `configuracoes/sistema`: `nome_loja, cnpj, formas_pagamento[], comissao{ base, percentual_padrao },
  parcelamento{ maximo, minimo_parcela, juros{ credito, crediario, debito } }`. Cada forma de
  `juros` e um mapa `"parcelas": { cliente, loja }` (percentuais): `cliente` e somado ao valor
  cobrado do comprador quando parcela; `loja` e o custo da loja (taxa de maquininha/financiamento,
  ex. da maquina de cartao) sobre o valor original — usado inclusive em "1" (a vista) pra
  credito/debito, ja que taxa a vista tambem e custo real. Configurado na tela como texto
  `"parcelas:pctCliente|pctLoja"` (ex. `"3:5|2"`), um campo por forma.
- `configuracoes/indicadores`: `site_url, percentual, janela_dias, categorias_excluidas[]`.
- `indicadores/{id}`: `nome, codigo, contato, ativo, anotacoes` (caixa de anotacoes livre do admin).
- `vendas/{id}`: venda da **loja fisica** (ou espelho de pedido do site, `canal:"site"`).
  `numero, canal ("loja"|"site"), data, vendedor_uid, vendedor_nome, itens[], subtotal, desconto,
  total, pagamentos[], status, caixa_id, comissao{ base, percentual, valor, status }`. Cada
  `pagamentos[i]` mantem `forma, valor` (valor ORIGINAL de tabela, sem juros — a base de calculo
  de comissao/relatorios nunca muda) e, so quando ha taxa configurada pra forma+parcelas, ganha
  `parcelas, valor_parcela` (parcelavel e >1) e os campos aditivos `juros_pct, pct_loja,
  valor_com_juros, custo_loja, valor_liquido`. A venda toda ganha os agregados
  `total_com_juros, custo_loja_total, valor_liquido` (todo consumidor le
  `v.valor_liquido ?? v.total` pra nao quebrar em vendas antigas nao migradas).
  **Importante**: `valor_liquido` desconta `custo_loja` do valor ORIGINAL (`valor`/`total`), NAO
  do valor com juros do cliente (`valor_com_juros`/`total_com_juros`) — o juros cobrado do
  cliente e so uma referencia informativa, nunca compensa o custo da maquininha nesse campo. Quem
  quiser o resultado financeiro do parcelamento (juros do cliente menos custo da loja) calcula
  na mao a partir dos campos brutos — e o que o Painel faz na linha "Juros" da contabilidade
  mensal (ver abaixo). No espelho do site (`canal:"site"`), `pagamentos[0]` so tem
  `forma, valor` e, se o pedido foi pago parcelado no Mercado Pago, `parcelas` (copiado de
  `pedidos/{id}.pagamento.parcelas`) — sem `valor_parcela`/`juros_pct`/`custo_loja`, porque o
  site nao calcula juros de parcelamento (isso e o Mercado Pago quem faz).
- `gastos/{id}`: despesa avulsa da loja, solta por data (nao amarrada a uma sessao de caixa).
  `descricao, categoria (texto livre, opcional), valor, data (Timestamp editavel), observacoes,
  criado_em, criado_por_uid, criado_por_nome`. Leitura pra qualquer staff; criar/editar/excluir
  **so admin**.
- `caixa/{id}`: `data, aberto_por_uid, valor_abertura, movimentos[], status,
  valor_fechamento_informado, resumo{ ..., valor_liquido_caixa, custo_loja_sessao,
  gastos_sessao, juros_cliente_sessao }`. Caixa e **unico pra loja toda** (nao "do usuario").
  `resumo` guarda o valor liquido contabil da sessao (vendido de TABELA, sem juros do cliente,
  menos custo de maquininha menos gastos do periodo) **a parte** do "dinheiro esperado na
  gaveta" (que continua so o calculo fisico de dinheiro, sem desconto nenhum);
  `juros_cliente_sessao` e so informativo, ja fora desse liquido.
- `configuracoes/sistema.point`: `{ ativo, obrigatorio, api_url }` — liga a maquininha no PDV,
  exige que credito/debito passem por ela, e onde esta a API (vazio = mesmo dominio).
- `cobrancas_point/{cobrancaId}`: uma cobranca na maquininha. **So o backend (Admin SDK) le e
  escreve** — cai no catch-all das rules, o navegador nao enxerga. `cobrancaId` (`pdv-<uuid>`)
  e o id do documento, a `external_reference` da order no MP e a chave de idempotencia.
  Campos: `status` (`criando|created|at_terminal|processed|failed|canceled|expired|refunded|erro`),
  `tipo`, `valor`, `parcelas_solicitadas`, `parcelas` (o que a maquininha reportou),
  `bandeira`, `valor_pago`, `custo_loja`, `liquido_mp`, `taxa_origem`, `order_id`,
  `payment_id`, `vendedor_uid`, `mp_raw` (ultima resposta crua do MP — pra depurar; pode sair
  depois da validacao).
- Venda paga na maquininha: `vendas.pagamentos[i]` ganha `point{cobranca_id, order_id,
  payment_id, bandeira, tipo, status}` e `origem_taxa` (`"maquininha"` = custo real informado
  pelo MP; `"estimada"` = o MP nao informou e usamos a tabela de juros). Os demais campos
  (`valor`, `valor_com_juros`, `custo_loja`, `valor_liquido`, `parcelas`...) tem o mesmo
  significado de sempre, so que com numeros reais.
- `contadores/vendas`: `ultimo_numero` (numeracao sequencial das vendas da loja).
- `comissoes/{AAAA-MM}/vendedores/{uid}`: consolidado do periodo.
- `integracoes/{canal}`: tokens de marketplace (Fase 3+; `read, write: if false` — so
  o backend Admin SDK).

O **Painel** consolida uma "Contabilidade mensal" (admin) direto de `vendas`+`gastos` por
intervalo de mes — nunca somando documentos de `caixa` (evita contar gasto em dobro e cobre
vendas 100% credito que podem fechar sem caixa aberto): Receita bruta, Juros (resultado liquido
do parcelamento, pode ser negativo), Gastos, Comissao de vendedores, Comissao de indicadores,
Valor liquido do mes.

Colecoes **do site** que o sistema consome:

- `produtos/{id}`: `nome, codigoBarras, categoria (slug legado), filtros{ camadaSlug: [...] },
  precoVarejo, precoAtacado, estoque (pool unico, sem separacao varejo/atacado),
  ativo (bool), descontoAtivo, descontoPercentual, imagemURL, peso, descricao, destaque,
  freteDisponivel`. Helpers: `infoPreco(p, modo)`, `estoquePorModo(p)`.
- `camadas/{id}`: `nome, slug, ordem, opcoes[]` (a camada de `ordem` 1 e a principal;
  iPhone = opcao cujo slug comeca com "iphone").
- `pedidos/{id}`: pedido do site, criado pelo cliente. **Sem valores monetarios.**
  `uidComprador, itens: [{produtoId, quantidade, modo}], temItemAtacado, modoEntrega
  ("entrega"|"retirada"), endereco | null, status, pagamento{ metodo, status, parcelas },
  criadoEm` + opcionais `ref` (codigo do indicador) e `refEm`. Totais sao **derivados** do
  catalogo. `pagamento.parcelas` e escrito pelo backend do site (webhook do Mercado Pago)
  quando o metodo e `mercadopago` — quantidade de parcelas escolhida pelo cliente no
  Checkout Pro; o site nao calcula nem guarda o valor de cada parcela (isso e o Mercado
  Pago que mostra na tela dele), so a quantidade.

---

## 9. Notas de seguranca

- O front-end usa so a config publica; o controle real esta nas **Security Rules**.
- Vendedor le a propria comissao (nao a dos colegas), mas caixa e vendas sao
  **compartilhados** (o caixa e unico pra loja toda) e `pedidos`/`usuarios` do
  site tambem sao legiveis por vendedor (precisa pra tela de Pedidos —
  confirmar retirada/entrega e ver nome/telefone do comprador).
- Um vendedor ativo so pode alterar `estoque`/`atualizadoEm` em `produtos`
  (baixa do PDV) — nada mais. Estoque e um pool unico (sem separacao
  varejo/atacado); so o preco continua tendo dois valores.
- `integracoes/*` sem leitura/escrita pelo cliente (`if false`) — reservado ao backend
  das fases 3/4.
- **Deploy de `firestore.rules`/`firestore.indexes.json` so a partir deste repo.**
  Publicar a copia do repo do site sobrescreve o que o sistema precisa.
- A API da maquininha (`api/`) usa o **Admin SDK, que ignora as rules**: por isso ela mesma
  confere quem chama (ID token do Firebase + papel lido de `usuarios/{uid}`, igual `ehStaff`/
  `ehAdmin`), limita rajadas por usuario e so o admin estorna/troca o modo do terminal. O
  `MP_ACCESS_TOKEN` e a service account vivem so nas variaveis da Vercel — nunca no front.

---

## 10. Maquininha Mercado Pago Point (opcional, em teste)

Cobra credito e debito **direto na maquininha pelo PDV** e grava a taxa real de cada venda
(em vez da estimativa da tabela de juros). Usa a **Orders API do Point**. Desligada por
padrao (Configuracoes → Maquininha); com ela desligada nada muda.

### Como funciona

```
PDV ── /api/point/cobrar ──▶ API (Vercel) ── POST /v1/orders ──▶ Mercado Pago ──▶ maquininha
 ▲                              │  grava cobrancas_point/{id}                        │ cliente passa o cartao
 └── /api/point/status ◀────────┘◀── GET /v1/orders/{id} (a cada consulta) ◀─────────┘
                                 ◀── /api/webhook-point (rede de seguranca)
```

- O PDV consulta `/status` a cada ~2,5 s enquanto o modal esta aberto. **Cada consulta busca o
  estado direto no MP**, entao o fluxo funciona mesmo sem o webhook configurado; o webhook so
  cobre a cobranca aprovada que ninguem esta mais acompanhando (aba fechada).
- O estado so avanca (`created → at_terminal → processed…`): resposta atrasada nunca desfaz
  uma aprovacao. Repetir `/cobrar` com o mesmo id nao cria outra order.
- Na venda ficam os numeros que a maquininha reportou: parcelas (o cliente pode trocar por la),
  valor cobrado, custo da loja. `valor` continua sendo o valor de tabela (base de comissao) e
  `valor_liquido = valor − custo_loja`, a mesma regra de antes.
- **Quem paga o juros** segue a tabela de juros que ja existe: cliente com juros > 0 no numero de
  parcelas = `buyer` (o cliente paga); senao `seller` (a loja absorve). Quem define as taxas
  reais e o contrato do Mercado Pago, nao a tabela (detalhes abaixo).

### Quem controla as taxas?

**O Mercado Pago**, nao o sistema. A taxa por parcela e o prazo de recebimento (na hora, 14 ou 30
dias) sao do plano da conta no MP; o sistema nao altera isso.

| O que | Quem define | Como o sistema fica sabendo |
|---|---|---|
| Custo da loja (a taxa) | Mercado Pago (plano da conta) | depois de aprovar, le o valor liquido no MP: custo = valor − liquido |
| Quanto o cliente pagou (com juros, se houver) | Mercado Pago | le o total realmente cobrado |
| Estimativa antes de cobrar | tabela de juros em Configuracoes | so uma conta local |

- Venda aprovada na maquininha usa **so os numeros reais** (`origem_taxa: "maquininha"`). A tabela
  **nao** entra na conta, entao nao ha desconto em dobro.
- A tabela de juros passa a servir pra: (1) mostrar a **previa** no PDV antes de cobrar; (2) ser a
  **estimativa de reserva** se o MP nao devolver as taxas (a venda fica `origem_taxa: "estimada"`);
  (3) decidir **quem paga o juros** (cliente com juros > 0 → `buyer`); (4) cartao registrado a mao
  e crediario, que nao passam pela maquininha.
- A API so deixa escolher **quem** paga o juros, **nao o percentual**: se a tabela diz 5% pro
  cliente, a maquininha aplica o percentual do MP, que pode ser outro. No primeiro teste deixe
  "cliente" = 0 (o cliente paga o preco cheio) e veja o custo real.
- Mantenha a tabela perto das taxas reais do plano pra previa e estimativa nao mentirem; compare
  o custo real com o estimado com `python scripts/conciliar_point.py`.

### Rotas (`api/`)

| Rota | Quem | O que faz |
|---|---|---|
| `POST /api/point/cobrar` | equipe | cria a order na maquininha `{cobrancaId, tipo, valor, parcelas, quemPagaJuros}` |
| `GET /api/point/status?cobrancaId=` | dono da cobranca ou admin | atualiza no MP e devolve o estado |
| `POST /api/point/cancelar` | dono ou admin | cancela a cobranca **so ate ela chegar na maquininha** (depois, so na propria maquininha; ver "Cancelar uma cobranca") |
| `POST /api/point/estornar` | **admin** | estorno total (ate 90 dias) |
| `GET/POST /api/point/terminais` | **admin** | lista terminais / troca modo `PDV` ↔ `STANDALONE` |
| `GET /api/point/diagnostico` | **admin** | checklist: token do MP, Firebase, terminais, modo PDV (nunca devolve segredo) |
| `POST /api/webhook-point` | Mercado Pago | topico `orders`; valida `x-signature` |

### Conectar hoje (teste local, sem publicar nada)

A API roda **no seu computador** e usa o **mesmo Firestore de producao**: as vendas do teste sao
**reais** (gravam no sistema e baixam estoque). Use valor pequeno e cancele depois em Vendas.

1. **Mercado Pago**: loja e caixa criados e a maquininha vinculada pelo app (ver "Colocar no ar",
   passo 1), mais o **Access Token de producao** da aplicacao (*Suas integrações → sua aplicacao →
   Credenciais de producao*, comeca com `APP_USR-`; `TEST-` nao serve pra maquininha real).
2. **Dois arquivos na raiz do repositorio** (os dois estao no `.gitignore`, nada vai pro git):
   - `.env`: `Copy-Item .env.example .env` (PowerShell) e preencha **so** `MP_ACCESS_TOKEN`.
   - `serviceAccount.json`: o mesmo que os scripts Python ja usam (secao 3). Nao precisa preencher
     `FIREBASE_SERVICE_ACCOUNT`; se preferir, `GOOGLE_APPLICATION_CREDENTIALS` tambem vale.
3. `npm install` (uma vez) e depois:

   ```bash
   npm run point:check -- --gravar --colocar-pdv
   ```

   Confere token, Firebase e terminais, **grava o id do terminal no `.env`** (se a conta tiver mais
   de um, use `--terminal <id>`) e coloca a maquininha em **modo PDV** (ela passa a aceitar so
   cobranca do sistema; volta ao normal em Configuracoes → Maquininha → *Voltar ao modo
   autonomo*). Sem as opcoes, so confere. Tudo em `[ OK ]` = pronto; o que faltar vem com o que fazer.
4. Em **dois terminais**, deixando os dois abertos:

   ```bash
   npm run api:dev                 # API local em http://127.0.0.1:3001
   python scripts/dev_server.py    # o sistema em http://localhost:5173
   ```

5. Entre em `http://localhost:5173` como **administrador** → Configuracoes → *Teste so neste
   computador* → **Ativar teste local**. A URL da API local (`http://localhost:3001`) ja vem
   preenchida nesse bloco. Vale **so neste navegador** (nao muda a configuracao dos outros
   usuarios) e o PDV mostra uma faixa amarela "TESTE LOCAL" enquanto estiver ligado. Em
   *Maquininha* clique **Testar conexao**: o checklist tem que ficar todo verde.

   **Onde vai cada URL** (nenhuma vai na maquininha — ela so precisa estar vinculada a conta do MP
   e em modo PDV):

   | Onde | URL | Quando |
   |---|---|---|
   | *Teste so neste computador* → URL da API local | `http://localhost:3001` | teste de hoje |
   | *Maquininha* → URL da API publicada | a URL que a Vercel der ao publicar | dia a dia (vale pra todos) |
   | Painel do MP → Webhooks (topico Order) | `https://<sua-api>/api/webhook-point` | opcional, so depois de publicar |

   O campo *Maquininha → URL da API* pode ficar vazio no teste local (o PDV so usa a URL **salva**
   ou a do teste local, e salvar `localhost` ali valeria pra todo mundo). *Testar conexao* usa o
   que estiver digitado nele sem salvar.
6. **Primeira cobranca**: no PDV, um produto com **Desconto** ate o total dar **R$ 1,00** →
   pagamento **Debito** → **Cobrar na maquininha** → o cliente passa o cartao → finalize. Confira a
   linha (taxa e `origem_taxa`). Depois **cancele a venda em Vendas** (estorna no cartao e devolve o
   estoque). Repita com **credito 3x** e olhe `cobrancas_point/{id}.mp_raw` / `mp_pagamento_raw`.
7. Terminou: **Desativar teste local** (em Configuracoes ou na faixa do PDV). Pra usar de verdade
   no dia a dia, siga "Colocar no ar".

Se algo falhar, o `point:check` e o **Testar conexao** dizem o que:

| Sintoma | Causa provavel | O que fazer |
|---|---|---|
| `[ERRO] Access Token` — "UNAUTHORIZED" | token errado, incompleto ou de outra conta | copie o Access Token de **producao** inteiro, da conta dona da maquininha |
| `[ERRO] Firebase` | sem `serviceAccount.json` na raiz | ponha o arquivo (ou defina `FIREBASE_SERVICE_ACCOUNT`) |
| `Firebase` avisa outro projeto | chave de outro projeto | gere a chave no projeto `flora-5754a` (senao todo login e recusado) |
| "nenhum terminal" | maquininha nao vinculada a loja/caixa | vincule pelo app do MP (QR Code no terminal) |
| terminal em modo `STANDALONE` | maquininha em modo autonomo | `--colocar-pdv`, ou o botao em Configuracoes; reinicie a maquininha se nao mudar |
| Testar conexao: "Sem conexao" | `api:dev` fechado ou porta diferente | rode `npm run api:dev` e deixe aberto |
| "Sem conexao" mas o `api:dev` esta rodando (no console do navegador, F12: `No 'Access-Control-Allow-Origin'`) | CORS: um `CORS_ORIGINS` no `.env` substitui a lista padrao e deixa o sistema local de fora | o `api:dev` ja libera `http://localhost:5173` sozinho (reinicie-o e veja a linha `CORS_ORIGINS` no banner); se abrir o sistema em outra porta, ponha essa origem em `CORS_ORIGINS` |
| Testar conexao: "URL da API esta vazia" | nenhum teste local ativo e o campo da URL vazio | ative o *Teste so neste computador* (ou preencha a URL publicada) |
| Testar conexao: "nao aceitou o seu login" | service account de outro projeto | use a chave do `flora-5754a` e entre de novo |
| "cobranca pendente na maquininha" | ja existe uma cobranca aberta la | conclua ou cancele na propria maquininha |
| Cancelar cobranca: "ja esta na maquininha, so da pra cancelar por la" | o Mercado Pago so cancela pela API antes da cobranca chegar na maquininha | aperte o **X** na maquininha; a tela do PDV percebe sozinha ("Cancelada na maquininha") |

### Colocar no ar (passo a passo)

1. **Mercado Pago**: crie a **loja** e o **caixa** no painel, vincule a maquininha pelo app do
   MP (QR Code no terminal) e crie uma aplicacao em *Suas integrações*. Modelos aceitos pela
   Orders API: Point Smart 1/2 e Point Pro 2/3. Um terminal em modo PDV por caixa.
2. **Vercel**: novo projeto apontando pra ESTE repo (Root Directory = raiz, sem framework;
   `vercel.json` ja aponta `public/` como saida). Variaveis (ver `.env.example`):
   `MP_ACCESS_TOKEN`, `MP_POINT_TERMINAL_ID`, `FIREBASE_SERVICE_ACCOUNT` (do projeto
   `flora-5754a`), `MP_WEBHOOK_SECRET` (opcional no comeco), `CORS_ORIGINS` (se o front ficar em
   outro dominio). Sem o id do terminal ainda? Deixe vazio, faca o passo 3 e volte.
3. **Achar o terminal**: em Configuracoes → Maquininha informe a URL da API e clique **Testar
   conexao**. O sistema lista os terminais da conta (com o id no formato `TIPO__SERIAL`) e o modo
   de cada um. Copie o id pra `MP_POINT_TERMINAL_ID`, redeploy, e use **Colocar em modo PDV**.
4. **Webhook** (recomendado): *Suas integrações → Webhooks*, topico **Order (Mercado Pago)**, URL
   `https://<sua-api>/api/webhook-point`; copie a assinatura secreta pra `MP_WEBHOOK_SECRET`.
5. Em Configuracoes marque **Usar a maquininha no PDV**. So depois de validar tudo, marque
   **Exigir a maquininha** (bloqueia registrar cartao "na mao").

Front no Firebase Hosting + API na Vercel (cross-origin) funciona: preencha a URL da API e, se
preciso, `CORS_ORIGINS`. Se preferir tudo na Vercel (mesma origem), deixe a URL vazia e
adicione o dominio da Vercel em *Firebase Auth → Authorized domains*.

### Plano B (internet ou sistema fora do ar)

Em modo PDV a maquininha **so aceita cobranca vinda do sistema**. Se cair, va em Configuracoes →
Maquininha → **Voltar ao modo autonomo** (ou troque o modo pelo app do MP) e cobre como uma
maquininha comum; registre o cartao manualmente no PDV (desmarque *Exigir a maquininha* antes).

### Teste recomendado (primeira vez)

Com dinheiro de verdade, valor pequeno: cobrar **R$ 1,00 no debito**, aprovar, conferir a venda
(`origem_taxa` e `custo_loja`), e **estornar** (Vendas → cancelar a venda estorna no cartao).
Depois **credito 3x** e olhe `cobrancas_point/{id}.mp_raw` / `mp_pagamento_raw` no Firestore. O
passo a passo esta em "Conectar hoje".

### O que ainda precisa ser confirmado no primeiro teste real

- O nome do campo de quem paga o juros: a doc do MP usa `installments_cost` numa pagina e
  `default_installments_cost` em outra (constante `CAMPO_QUEM_PAGA_JUROS` em `api/_lib/point.js`).
  Se o MP recusar um, a API tenta o outro **uma vez** sozinha (so em credito) — o log mostra qual.
- De onde vem a **taxa real**: o codigo tenta o pagamento na API classica
  (`/v1/payments/{reference_id}` → `net_received_amount`/`fee_details`). Se a order nao trouxer
  esse id, a taxa cai em `origem_taxa: "estimada"` — o `mp_raw` mostra o formato verdadeiro.
- Cancelar uma cobranca que ja esta na maquininha (`at_terminal`) pela API: a referencia da API
  diz que so cancela uma order em `created` (segundos depois de criada) e que em `at_terminal`
  responde 409 `cannot_cancel_order`. O guia de migracao cita o header
  `x-allow-cancelable-status: at_terminal` (continuamos mandando), mas o cancelar do primeiro teste
  real falhou. Agora a tela mostra o motivo exato devolvido pelo MP: confirme aqui no proximo
  teste. Se um dia a maquininha aceitar o header, o cancelamento pela API volta a funcionar sozinho
  (ver "Cancelar uma cobranca").

### Cancelar uma cobranca

- **Antes de chegar na maquininha** (poucos segundos apos criar, status `created`): o botao
  *Cancelar cobranca* do PDV cancela pela API.
- **Ja na maquininha** (`at_terminal`): so ela cancela — aperte o **X** nela. O PDV avisa isso na tela
  (o botao some) e **percebe sozinho** quando cancelam la: a cobranca vira "Cancelada na maquininha"
  e a linha do pagamento e liberada. O mesmo vale pro botao *Limpar* com cobranca aberta.
- Se o cliente pagar no mesmo instante em que a vendedora cancela, o *Limpar* **nao apaga** o
  pagamento: a linha passa a "cobrada" (finalize a venda ou use *Limpar* de novo pra estornar).
- Cada tentativa de cancelar/estornar usa uma chave de idempotencia **nova** (o MP recusa reuso da
  mesma) e "ja cancelada"/"ja estornada" no MP conta como sucesso. Qualquer outra recusa do MP
  aparece na tela com o motivo real.

### Operacao

- `python scripts/conciliar_point.py` lista **cobranca aprovada sem venda** (cliente pagou, ninguem
  registrou), pendencias travadas e estornos ligados a venda concluida. Rode de vez em quando.
- Fechar o modal com a cobranca viva deixa **Acompanhar** na linha. Recarregar a aba com
  cobranca no carrinho pede confirmacao (perder o vinculo gera o caso acima).
- Cancelar uma venda paga na maquininha estorna no cartao antes; se o estorno falhar a venda
  **nao** e cancelada.
