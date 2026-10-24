# Ciclo de melhoria do pareamento: passagem de bastão

Este arquivo é a memória do ciclo. Qualquer sessão nova (no Mac ou na nuvem) começa lendo **este arquivo** e
`docs/analise-pareamento-imoveis.md`, que traz o diagnóstico completo, os bugs com arquivo:linha e o pipeline recomendado.

## Papéis (pedido do dono do projeto)

- **Opus = chefe.** Planeja cada rodada, revisa o diff do Sonnet, roda a avaliação e decide se mantém ou descarta.
- **Sonnet = escreve o código** (Agent com `model: "sonnet"`), com briefings curtos e focados.
- **Fable = avaliador** (Agent com `model: "fable"`). Entra só nos marcos: depois do scraper, depois de
  metadados + fotos reaproveitadas, e no final. Não entra em toda rodada.
- **Economizar tokens:** revisar só diffs e a linha de métricas; nunca despejar JSON grande na conversa.

## Regra do ciclo

1. Fazer **uma** alteração.
2. Gerar o arquivo de candidatas → `python3 scripts/evaluate_candidates.py <arquivo> --label <nome>` (imprime uma linha
   e grava em `data/eval/history.jsonl`).
3. Melhorou → commit + push e mantém. Não melhorou → descobrir o porquê, consertar uma vez ou descartar.
4. Parar uma linha de trabalho depois de 2 rodadas sem melhora; parar o ciclo depois de 3 técnicas seguidas sem melhora.
5. **No máximo 8 rodadas** no total (decisão do dono). Vale o que vier primeiro: o teto ou a regra do item 4.
6. **Só GPU do Mac** (PyTorch `device="mps"`), nunca GPU na nuvem. Modelos que exigem CUDA (ex.: kernel fundido do
   RoMa v2) ficam de fora ou rodam sem a parte CUDA. Avisar o dono antes de qualquer etapa paga (ex.: Gemini).
7. **Não ajustar pesos/limiares em cima do próprio gabarito.** Ajustar em Alphaville 1 e testar em Tamboré XI, ou usar leave-one-out.
   Com ~20 pares, cada par vale 5 pontos percentuais: diferença de 1 par não é melhora.

## Estado atual

| Rodada | Método | R@1 | R@3 | R@10 | MRR | n |
|---|---|---|---|---|---|---|
| 0 | `metadata-v1` (só metadados, pesos não ajustados) | 0,80 | 0,95 | 0,95 | 0,87 | 20 |

Erros da rodada 0: 13572 (certo em 14º), 14127 (3º), 14138 (2º), 17378 (2º; o 1º é o par de 17388 → provável anúncio duplicado na Viva).

Arquivos da base: `data/ground_truth.json`, `scripts/lib/ground_truth.py`, `scripts/lib/listings.py`,
`scripts/evaluate_candidates.py`, `scripts/metadata_ranker.py`.

## Próximos passos, em ordem

1. **Scraper** (`scripts/scrape-live-listing-details.js`): o preço é lido do widget de filtro (todos os anúncios da Viva fresh
   saem com R$ 1.000.000, 1 dorm, 1 vaga) e a Coelho perdeu "m² construída" e "m² do terreno". Corrigir e conferir contra
   `data/*/listings/all-listings.json` (as linhas da Viva precisam bater com o scrape de produção).
2. **Raspar de novo** Alphaville 1 e Tamboré XI com **todas** as fotos; salvar em `gs://realestate-475615-data`
   (os scripts `scripts/scrape-all-compounds-to-gcs.sh` e `scripts/sync-gcs-to-local.sh` já existem).
3. **Gabarito:** importar os ~39 pares confirmados na tela de revisão (GCS, `trial-summary`, `confirmed_matches`)
   para `data/ground_truth.json`; incluir negativos revisados.
4. **Fotos reaproveitadas:** SSCD + PDQ/pHash em todas as fotos, com versão espelhada; confirmar com SIFT/LightGlue + RANSAC.
5. **Fusão:** metadados + fotos reaproveitadas → candidatas; atribuição 1-para-1 por condomínio com opção "sem par".
6. **Verificação geométrica moderna** (LoMa / ALIKED+LightGlue no Mac via MPS; RoMa v2 se houver GPU), matriz fundamental
   MAGSAC++, teste espelhado, máscara da marca d'água da Coelho.
7. Máscara de piscina (SAM 3), texto da descrição, VLM como desempate. Ver o relatório para os detalhes.
