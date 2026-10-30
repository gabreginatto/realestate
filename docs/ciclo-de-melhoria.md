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
| 0b | `r0-metadata-pool` (anúncios novos + antigos; gabarito com pares da tela de revisão) | 0,596 | 0,702 | 0,894 | 0,682 | 47 |
| 1 ✅ | `r1-dups` (+ fotos reaproveitadas SSCD ≥0,75 / PDQ ≤31) | 0,638 | 0,723 | 0,894 | 0,712 | 47 |
| 2 ✅ | `r2a-sscd-lexi` (SSCD contínuo ≥0,42 primeiro) | 0,851 | 0,915 | 0,957 | 0,887 | 47 |
| 2 ❌ | `r2b-sscd-blend` (soma ponderada, CV) | 0,710 CV | — | — | 0,784 CV | 47 |
| 3 ✅ | `r3a-sscd-allpairs` (ordena todas as Coelho pelo máximo de SSCD entre todos os pares de fotos; o piso f não muda nada) | 0,936 (LOO 0,915) | — | — | 0,963 | 47 |
| 3 ❌ | `r3b-hungarian` (1:1 por condomínio) — +1 casa, falso alarme igual | 0,957 | — | — | 0,973 | 47 |
| 4 ✅ | `r4-topk-agg` (contagem de fotos da Viva com máx. SSCD ≥ 0,356 [p99 dos pares sem gabarito]; desempate por metadados) | **0,979 (LOO 0,979)** | — | — | 0,989 | 47 |

| 4b | `r4-live-count` (só raspagem de 25/10/2026, anúncios vivos nas duas pontas, Alphaville 1 + Tamboré XI; arquivo antigo descartado) | **1,000 (LOO 1,000)** | — | — | 1,000 | 32 |

Decisão "está na Coelho?" ainda não validada — não há rótulos negativos (o número anterior media outra coisa).
Lista para revisão em `data/review/to-label-r3.json`. Par 12252↔681867 restaurado como confirmado (a galeria da Viva tem 2 fotos de outra casa, 674139).
Rodadas usadas: 4 de 8 (4b é a mesma técnica sobre dados novos, não conta como rodada).

**25/10/2026: arquivo antigo abandonado.** As fotos antigas misturavam casas e incluíam anúncios vendidos. Agora só vale a raspagem do dia:
`scripts/audit-live-listing-counts.js` (lista viva das buscas) → detalhes → fotos → `scripts/fresh_photos.py` (`data/photos-fresh`) →
`topk_agg.py --live --photos-root data/photos-fresh` → `build_label_page.py --live`. Dados anteriores em `data/_snapshots/2026-10-24/` (fora do git).
Hoje: Viva 76 + 30, Coelho 75 + 31 anúncios vivos; 32 pares confirmados seguem vivos nas duas pontas. A Coelho anuncia a mesma casa mais de uma vez
(fotos diferentes), por isso a página aceita várias Coelho por Viva (`coelho` = códigos separados por vírgula).

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

**Rodada 5 (filtro de fotos genéricas, `scripts/photo_idf.py`)**: foto que casa (SSCD ≥ τ) com ≥3 anúncios distintos (outro site + mesmo site) é descartada da contagem.
Decisão (`--decision`): acurácia held-out 0,943 ± 0,019 (antes 0,901 ± 0,016), R@1 nos positivos vivos 1,000. Atenção: `nomatch_live` = "a casa não estava entre as 3
candidatas mostradas", não "não está na Coelho"; 12229→647221 e 18360→685893 são a mesma casa (conferido nas fotos), então a especificidade não é verdade-terreno.

## Rodada 7 (inventário da Coelho) e benchmark congelado (30/10/2026)

- **Inventário da Coelho está completo por condomínio**: Alphaville 1 declara 76 casas em condomínio (raspamos 75; +1 hoje, 585452), Tamboré XI declara 31 (raspamos 31).
  Paginação, venda e filtros conferem. O que falta é outra coisa: a Viva só foi raspada nesses dois condomínios, e a Coelho tem 1.226 casas à venda na categoria Alphaville
  (≈40 condomínios; só 106 estão no nosso conjunto). Casas da Viva "Alphaville 1/Tamboré XI" podem estar na Coelho sob outro nome de condomínio.
- Rastreamento: `scripts/r7_coelho_inventory.py` (cartões da busca, 30/página, 2 s entre páginas) → `data/r7/inv-alphaville-all.json`;
  `scripts/r7_select_candidates.py` (preço/construída/suítes) → 656 casas, detalhes raspados; 268 têm terreno ≤2% e mesmas suítes de algum dos 46 no_match;
  fotos baixadas só das 79 mais plausíveis (construída ≤20%, preço ≤15%): `data/r7-extra`, `data/r7-extra-b`. As outras 189 ficaram sem fotos (a CDN entrega ~0,5 MB/s).
- **Benchmark congelado** `python scripts/benchmark.py r5|r6|r7` (conjuntos em `data/benchmark/frozen-v1.json`; P, H, S, P_hard, U; portões: R@1(P)=1,000 e FPR(H)≤2%).
  Métrica a empurrar: `rec_hard_cv` (recall em P_hard, fotos com SSCD≥0,25 ou PDQ≤31 removidas).

## Rodada 8 e lista final (31/10/2026)

**Alteração única:** normalização por Coelho no verificador ("melhor mútuo"): `score'(v,c) = s(v,c)` se `v` é a Viva de maior score para `c`, senão 0
(`benchmark.py r8`, `--norm mutual|diff`). As "outras Viva" são os pares que o próprio benchmark pontua (`Ctx.bench_pairs`), para que a métrica
não dependa de quantos pares extras estão no cache. Alternativa `s − 0,5·melhor-outra` testada e descartada.

```
bench-r7 [PASS] R@1(P)=1.000 rec_hard_cv=0.702 rec_diff=0.941 (16/17) T=51 FPR_H=0.015 FPR_S=0.028 fires_U=2/42
bench-r8 [PASS] R@1(P)=1.000 rec_hard_cv=0.719 rec_diff=1.000 (17/17) T=46 FPR_H=0.015 FPR_S=0.011 fires_U=3/42   (mutual, mantida)
r8-diff  [PASS] R@1(P)=1.000 rec_hard_cv=0.684 rec_diff=0.941 T=32 FPR_H=0.015 FPR_S=0.011 fires_U=4/42           (descartada)
sem os 2 H suspeitos (18454↔678679, 17480↔675706; só relatório, rótulos intactos): r7 T=43 hard_cv=0.737 diff=1.000 | r8 T=31 hard_cv=0.737 diff=1.000 FPR_S=0.028
```

- Mantida pelos critérios do ciclo (R@1(P)=1, FPR_H ≤ 2 %, rec_diff e rec_hard_cv sobem), **mas o ganho é de 1 par em cada** (regra 7 do ciclo: 1 par não é melhora
  firme). O ganho real é FPR_S 2,8 % → 1,1 %. `rec_diff` (novo, P sem nenhuma cópia, SSCD máx < 0,50, todas as fotos) é o par 2075↔502738 (49 → acima de T = 46).
- **Limite do método:** a normalização só é válida com a matriz Viva × Coelho completa. Com o cache da varredura completa das 42 Viva do limbo (≈1.700 pares a mais)
  quase todo par H perde a disputa e T colapsa para 0 (23/42 disparos): "melhor mútuo" é estatística de ruído e não serve sozinho como limiar. Na lista final o limiar
  continua T = 46 (calibrado no benchmark) e o "melhor mútuo" vale sobre todos os pares pontuados.
- Limbo: 3 disparos acima de T (9624→352241, 18404→351828, 18369→565110), os dois primeiros já vistos e falsos; 18369→565110 tem construída 302 vs 800 m².
- **189 candidatas da rodada 7 sem foto**: fotos baixadas (`data/r7-extra-c`, 5.3 mil fotos; a CDN bloqueia por ~2 min depois de ~150 MB, retomei com atraso maior)
  e pontuadas contra as Viva do limbo com lote ≤ 2 % e mesmas suítes (335 pares, 163 candidatas). **Nenhum acerto real**: o único par acima de T é 1786→505106 (49);
  vi as galerias: casa térrea com piscina oval e escada externa vs sobrado com piso de mármore e piscina retangular (mesma construtora de parquet e janelas).
- **Lista final** `data/output/viva-not-at-coelho.csv|json` (`scripts/r8_final_list.py`): 106 Viva vivas = 59 `confirmed_at_coelho`, 3 `likely_at_coelho`
  (12229→647221, 18360→685893, 8748→661974, fotos copiadas ou score ≥ 349), 44 `not_found_at_coelho` ordenadas por confiança (7 alta, 14 média, 23 baixa).
  A confiança é heurística (melhor score bruto vs T, candidatas com metadado compatível não pontuadas, se a corretora já viu a Viva); 6 Viva já foram confirmadas em
  anúncios da Coelho que saíram do ar (14533, 1148, 5380, 8527, 12030, 14138). Casos acima de T julgados por mim a olho estão em `notes`.
- Limite: "não está na Coelho" vale para as 374 casas Alphaville da Coelho com fotos (106 dos dois condomínios + 268 candidatas da rodada 7; o inventário tem 1.226), não para toda a Coelho.
