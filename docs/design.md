# Design: Sistema interno Amira

> Fonte de verdade das decisões visuais. Atualize quando a direção mudar. Adições locais (uma tela nova) herdam daqui, não reescrevem.

## Contexto

- **Modo principal**: Operar (PDV, caixa, cadastros). O Painel é Operar com leitura rápida.
- **Cena de uso**: vendedora no balcão da perfumaria, notebook ou monitor no balcão, leitor de código de barras numa mão e cliente na frente. Precisa ver de relance o que está na sacola, quanto falta pagar e o que fazer a seguir. No fim do dia, a dona confere caixa e números sentada, com calma.
- **Identidade**: da loja (Amira). Bordô/vinho + dourado + logo do sol nascente. Herdada, não redesenhada.

## Direção

- **Tese**: "balcão de boutique". A interface se comporta como a sacola e a nota de uma perfumaria: o que foi escolhido fica num papel destacado, o total aparece em destaque e o próximo passo é óbvio. Ela recusa o formulário-lista genérico de admin, em que tudo tem o mesmo peso (carrinho no meio dos inputs, rótulo em caixa alta em todo campo).
- **Mundo**: sacola de papel da loja, nota de balcão impressa, etiqueta de preço de perfume, vitrine com bandeja dourada, caderno de fiado.
- **Primeira tela (PDV)**: três zonas fixas, da esquerda pra direita na ordem da tarefa: **Adicionar produtos** → **Sacola** (superfície de papel, contador de itens, total) → **Cliente e pagamento** (resumo fixo com o "falta/troco" e o botão de finalizar).
- **Momento memorável**: o item entra na sacola com um realce dourado breve e o contador "pula". É o único movimento autoral; o resto é transição de estado curta.

## Fundação

| Camada | Decisão | Onde vive no código |
|---|---|---|
| Cor | Marca: vinho `#7a1f2b` (ação primária, sidebar), dourado `#c0913f` (item ativo, realce). Neutros quentes (fundo `#f6f1ef`, papel `#fffaf4`). Status reservados (ok/aviso/erro/info), sempre com ícone + texto. | `public/assets/css/base.css` `:root` |
| Tipografia | **Manrope** pra toda a UI e todos os números (`tabular-nums` em tabela/valor). **Fraunces** só em títulos de página e de seção (toque de boutique). Rótulos em caixa normal, 13px semibold. | `base.css` + `<link>` do Google Fonts em cada `.html` |
| Espaçamento | Escala 4/8/12/16/20/24/32 (`--s-*`). | `base.css` |
| Raio e elevação | Raio 8 (controle), 12 (card), 14 (modal). Cards só com borda; sombra só no que flutua (toast, modal, popover). | `base.css` |
| Movimento | 150ms (hover/foco), 220ms (entrada de toast/modal), ease-out `cubic-bezier(.16,1,.3,1)`. `prefers-reduced-motion` desliga. | `base.css` |
| Ícones | Lucide v0.460, uma família, traço 2, herda `currentColor`. | `public/assets/js/icons.js` (`icone(nome)`) |

## Recursos adotados

| Recurso | Para quê | Adaptação feita |
|---|---|---|
| Lucide (lucide-static) | Ícones de navegação, ações e estados | Embutidos como SVG inline num mapa único; sem dependência em runtime |
| Google Fonts (Manrope, Fraunces) | Tipografia | Só pesos usados (Manrope 400–800, Fraunces 600) |
| Gráficos | Painel | SVG/HTML próprio, série única na cor da marca, barra ≤ 24px com ponta arredondada, tooltip no hover, valor também em texto |

## Regras do projeto

- Stack é HTML + CSS + JS puro (ES modules). Sem framework nem lib de componentes: tudo em `base.css` + helpers em `ui.js`.
- Toda mensagem ao usuário passa por `toast(msg, tipo)` (ok/err/warn/info); confirmação destrutiva por `confirmar()`.
- Nada de rótulo em caixa alta com espaçamento, emoji como ícone ou borda grossa só de um lado.

## Em aberto

- Tema escuro: não faz sentido na cena (loja iluminada de dia); não implementado.
