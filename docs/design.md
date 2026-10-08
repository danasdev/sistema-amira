# Design: Sistema interno Amira

> Fonte de verdade das decisões visuais. Atualize quando a direção mudar. Adições locais (uma tela nova) herdam daqui, não reescrevem.

## Contexto

- **Modo principal**: Operar (PDV, caixa, cadastros). O Painel é Operar com leitura rápida.
- **Cena de uso**: vendedora no balcão da perfumaria, notebook ou monitor no balcão, leitor de código de barras numa mão e cliente na frente. Precisa ver de relance o que está na sacola, quanto falta pagar e o que fazer a seguir. No fim do dia, a dona confere caixa e números sentada, com calma.
- **Identidade**: da loja (Amira). Bordô/vinho + dourado + logo do sol nascente. Herdada, não redesenhada.

## Direção (v2, 2026-10-08: "vitrine de vidro")

Pedido da dona: interface mais clean e refinada, fontes finas, ícones simples, cards espelhados, estilo Apple, menos texto e menos digitação. A v2 mantém a estrutura da v1 (abaixo) e troca a superfície:

- **Superfície**: cards de vidro translúcido com reflexo diagonal ("espelhado") sobre fundo creme com brilho bordô/dourado. Sidebar clara de vidro; logo pintado de vinho via máscara CSS. Glass e raio 18px estavam na lista de "evitar" do piso: entram aqui porque o brief pediu explicitamente.
- **Tipo**: uma família só, Inter 300–600. Números grandes em peso 300 (estilo Apple). Sem serifa.
- **Ícones**: Lucide com traço 1.5. Em listas de ajustes, ícone branco num quadradinho colorido (padrão Ajustes do iOS, usado só nas listas de configuração).
- **Controles (Kinetics, reimplementados)**: interruptor com mola, segmentado com pílula deslizante, stepper, chips, entrada de etiquetas, contador animado, botão salvar com status, acordeão, toast com overshoot, entrada em cascata. Código em `public/assets/js/componentes.js`.
- **Configurações**: abas + listas agrupadas estilo Ajustes; nada de texto separado por vírgula nem "+ adicionar linha" (a grade de juros mostra 1x até o máximo).

## Direção v1

- **Tese**: "balcão de boutique". A interface se comporta como a sacola e a nota de uma perfumaria: o que foi escolhido fica num papel destacado, o total aparece em destaque e o próximo passo é óbvio. Ela recusa o formulário-lista genérico de admin, em que tudo tem o mesmo peso (carrinho no meio dos inputs, rótulo em caixa alta em todo campo).
- **Mundo**: sacola de papel da loja, nota de balcão impressa, etiqueta de preço de perfume, vitrine com bandeja dourada, caderno de fiado.
- **Primeira tela (PDV)**: três zonas fixas, da esquerda pra direita na ordem da tarefa: **Adicionar produtos** → **Sacola** (superfície de papel, contador de itens, total) → **Cliente e pagamento** (resumo fixo com o "falta/troco" e o botão de finalizar).
- **Momento memorável**: o item entra na sacola com um realce dourado breve e o contador "pula". É o único movimento autoral; o resto é transição de estado curta.

## Fundação

| Camada | Decisão | Onde vive no código |
|---|---|---|
| Cor | Marca: vinho `#7a1f2b` (ação primária, sidebar), dourado `#c0913f` (item ativo, realce). Neutros quentes (fundo `#f6f1ef`, papel `#fffaf4`). Status reservados (ok/aviso/erro/info), sempre com ícone + texto. | `public/assets/css/base.css` `:root` |
| Tipografia | **Inter** 300–600 em tudo (v2). Números grandes em 300, `tabular-nums` em tabela/valor. Rótulos em caixa normal, 12.5px medium. | `base.css` + `<link>` do Google Fonts em cada `.html` |
| Espaçamento | Escala 4/8/12/16/20/24/32 (`--s-*`). | `base.css` |
| Raio e elevação | Raio 10 (controle), 18 (card), 22 (modal). Vidro: fundo translúcido + `backdrop-filter` + borda de luz + sombra suave. | `base.css` (`--vidro`, `--reflexo`) |
| Movimento | Mola `cubic-bezier(.34,1.56,.64,1)` (interruptor, stepper, toast, botão) e glide `cubic-bezier(.22,1,.36,1)` (pílula, entrada). 160/260/420ms. `prefers-reduced-motion` desliga. | `base.css` (`--mola`, `--glide`) |
| Ícones | Lucide v0.460, uma família, traço 1.5, herda `currentColor`. | `public/assets/js/icons.js` (`icone(nome)`) |

## Recursos adotados

| Recurso | Para quê | Adaptação feita |
|---|---|---|
| Lucide (lucide-static) | Ícones de navegação, ações e estados | Embutidos como SVG inline num mapa único; sem dependência em runtime |
| Google Fonts (Inter) | Tipografia | Pesos 300–600, eixo óptico |
| Kinetics (kinetics.colorion.co) | Comportamento dos controles | Reimplementados em CSS/JS próprio com os tokens da loja; nada copiado |
| Gráficos | Painel | SVG/HTML próprio, série única na cor da marca, barra ≤ 24px com ponta arredondada, tooltip no hover, valor também em texto |

## Regras do projeto

- Stack é HTML + CSS + JS puro (ES modules). Sem framework nem lib de componentes: tudo em `base.css` + helpers em `ui.js`.
- Toda mensagem ao usuário passa por `toast(msg, tipo)` (ok/err/warn/info); confirmação destrutiva por `confirmar()`.
- Nada de rótulo em caixa alta com espaçamento, emoji como ícone ou borda grossa só de um lado.

## Em aberto

- Tema escuro: não faz sentido na cena (loja iluminada de dia); não implementado.
