# Análise do pipeline de pareamento Viva Prime ↔ Coelho da Fonseca

_Outubro de 2026. Auditoria do código e dos resultados em `data/` + levantamento do estado da arte em pareamento de imagens._

> **Resumo em uma frase:** o problema foi tratado como "achar a piscina mais parecida", quando deveria ser
> "filtrar pelos dados do imóvel, achar fotos reaproveitadas, e só então verificar geometricamente as poucas
> candidatas que sobraram". Os dados do próprio repositório mostram que **só a metragem do terreno/construída já
> coloca a casa certa em 1º lugar em 71% dos casos e no top‑5 em 90%** — melhor que qualquer modelo de visão testado.

---

## 1. Como o pipeline funciona hoje

1. **Scraping** (Playwright / `scripts/scrape-live-listing-details.js`): fotos (~30 por anúncio), preço, dorms/suítes/vagas, área construída, área do terreno, descrição.
2. **Seleção de fotos com CLIP** (`scripts/dino-select-exteriors.py`): classifica cada foto em piscina / fachada / jardim / interior; guarda até 4 piscina + 2 fachada + 2 jardim; **todas as fotos internas são descartadas**.
3. **Embeddings globais** (DINOv3 CLS, "VLAD" sobre DINO, MegaLoc, patch‑VLAD) → matriz de similaridade 62×91 → **Hungarian 1‑para‑1 + um limiar**.
4. **Verificação geométrica** (`scripts/geometric-reranker.py`): ORB 2500 pontos, imagem reduzida a 900 px, `findHomography` RANSAC, nota satura em 35 inliers, corte `min_inliers=20`.
5. **Tiers** (`scripts/tiered-matcher.py`) e rodadas que vão relaxando os limiares (`scripts/run-community-matching.js`).
6. **Revisão humana** em mosaicos 320×320 das ≤8 fotos externas (`scripts/review-server.js`).

Os dados do imóvel (metragem, preço, quartos) só entram como um portão bem largo (±35% preço, ±30% área) ou um pequeno bônus.

## 2. O que os números dizem

Ground truth no código: **21 pares confirmados** (`CONFIRMED_PAIRS`, copiado em 6+ scripts). A interface de revisão já tem ~39 confirmados que nunca voltaram para o código.

| Método | Precisão | Recall | nº pares |
|---|---|---|---|
| DINO média + Hungarian | 0,16–0,19 | 0,48–0,57 | 61–62 |
| MegaLoc | 0,79 | 0,71 | 19 |
| Patch‑VLAD (32 / 64) | 0,65 / 0,81 | 0,81 / 0,62 | 26 / 16 |
| ORB + RANSAC | 0,87 | 0,62 | 15 |
| Tiered (tier alto) | 1,00 | 0,62 | 13 |

Atenção: esses números são **otimistas**, porque os limiares foram escolhidos varrendo milhares de combinações em cima dos mesmos 21 pares que depois servem de "teste".

### Duas descobertas que mudam tudo

**(1) Metade dos acertos é a mesma foto reaproveitada.** Dos 18 pares verdadeiros encontrados por algum método, 9 têm ≥142 inliers ORB (7 com >1700 = foto praticamente idêntica). Os outros 9 — os casos *difíceis*, de foto diferente da mesma casa — têm 6–34 inliers, a mesma faixa dos falsos positivos (7–24). Ou seja: a etapa geométrica atual só separa "mesma foto" de "foto diferente"; ela **não verifica "mesma casa, foto diferente"**. E 3 pares (2075↔502738, 17378↔659639, 13572↔653980) não são recuperados por nenhum modelo.

**(2) Os metadados sozinhos ganham de 1,5 ano de visão computacional.** Recalculado de forma independente com os dados de produção (`data/*/listings/all-listings.json`), ordenando os 91 anúncios da Coelho por uma pontuação simples (diferença relativa de terreno e área construída, peso menor para preço, quartos, suítes, vagas):

| | Valor |
|---|---|
| Casa certa em 1º lugar (R@1) | **71%** |
| Casa certa no top‑5 (R@5) | **90%** |
| Casa certa no top‑10 | 95% |
| Posição mediana | **1º de 91** |

A área do terreno é **idêntica** em 14 de 21 pares confirmados; a área construída em 12 de 21. O preço é o campo **menos confiável** (até 21,5% de diferença em pares confirmados), mas é o que tem mais peso hoje (25% em `build_ranked_output`).

## 3. O que está errado (do mais grave ao menos grave)

1. **Enquadramento invertido: visual primeiro, metadados por último.** O certo é filtrar por condomínio + terreno + área construída + quartos/suítes, e usar as imagens só para *decidir* entre as ~5–10 candidatas que sobram.
2. **Avaliação viciada.** GT pequeno (21), enviesado (veio das saídas do próprio sistema), sem negativos ("esta casa não está na Coelho"), limiares ajustados no próprio conjunto de teste, GT copiado em vários arquivos e confirmações da interface que nunca voltam.
3. **Hungarian 1‑para‑1 como produto final.** O revisor só vê *uma* candidata por anúncio; a 2ª e a 3ª melhores nunca aparecem. As "rodadas relaxadas" são um remendo que só gera ruído.
4. **Fotos reaproveitadas não são procuradas em toda a galeria.** É o sinal mais barato e mais preciso que existe, mas só é checado nas ≤8 fotos externas e só nos pares que os modelos globais já propuseram. As fotos internas (cozinha, banheiro, escada) são descartadas — e é nelas que muitas vezes a foto é reaproveitada.
5. **Tipo de feature errado para identificar uma casa específica.** DINO/CLIP/MegaLoc codificam "piscina com deck e palmeiras" — semântica, não identidade. Por isso todas as similaridades ficam entre 0,75 e 0,93. Além disso: recorte central de 224 px (perde ~1/3 da largura da foto 3:2), MegaLoc distorce a proporção, nenhuma centralização/whitening dos vetores.
6. **Verificador geométrico fraco.** ORB não é robusto a escala/iluminação; **homografia é o modelo errado** para cena 3D (só o plano da piscina é plano); nota satura em 35 inliers (35 ≡ 1993); **não testa a foto espelhada** (agências espelham fotos, e nenhum descritor é invariante a espelhamento).
7. **Scraper novo destruiu os metadados** (ver bugs 1–3): no pipeline "fresh", todo anúncio da Viva tem preço R$ 1.000.000, 1 dorm, 1 vaga e área vazia; a Coelho perdeu a área do terreno. Com esses dados o portão estrutural rejeita **todas** as candidatas.
8. **Marca d'água da Coelho** (grande, semitransparente, no centro de toda foto) contamina embeddings, rótulos do CLIP e cria pontos ORB espúrios.
9. **Descrições não são usadas.** Agências frequentemente copiam o texto do proprietário.
10. **Tela de revisão esconde evidência:** mosaico com `fit: cover` corta ~45% de cada foto, fotos internas escondidas, sem desenho das correspondências, sem tabela de diferenças de metadados.

## 4. Bugs concretos

| # | Onde | O quê |
|---|---|---|
| 1 | `scripts/scrape-live-listing-details.js:147-150, 172-176, 209, 215-218` | `parsePrice` pega o primeiro "R$" da página; `sectionSlice` devolve o HTML inteiro quando não acha `#detalhes`; preço/dorms/vagas são lidos do widget de filtro da busca. **76/76 anúncios Viva fresh com "R$ 1.000.000,00"** (verificado). Crítico. |
| 2 | `scripts/scrape-live-listing-details.js:265-270` + `recursive-matcher-v2.py:118` | `features` da Coelho perdeu "construída" e "m² do terreno" → `area=None` para todos os anúncios fresh, e o campo mais discriminativo some. |
| 3 | `scripts/run-community-matching.js:206-218` + `tiered-matcher.py:155-174, 244-246` | Prefere os dados fresh → `price_diff ≈ 1,7` em todo par → `reject-low` em **todas** as candidatas → fila de revisão vazia. |
| 4 | `scripts/recursive-matcher-v2.py:465-471` vs `:509, :516` | Multiplica cada vetor pelo peso da categoria e depois normaliza L2 → o peso piscina/fachada/jardim **não tem efeito nenhum** no modo VLAD (verificado). |
| 5 | `recursive-matcher-v2.py:1804-1860, 1867-2030`; `geometric-reranker.py:222-251`; `megaloc-matcher.py:207-222`; `patch-vlad-matcher.py` | Varredura de 2304 / 2142 combinações escolhida em cima dos mesmos 21 pares reportados como benchmark (vazamento treino→teste). |
| 6 | `scripts/tiered-matcher.py` `evaluate()` | Rodadas ≥2 avaliam contra o GT completo mesmo depois de remover os pares confirmados → P = 0,07/0,08 sem significado. |
| 7 | `dino-server/main.py:43-44`; `patch-vlad-matcher.py:100`; `megaloc-matcher.py:85` | Resize 256 + CenterCrop 224 descarta ~42% da largura; MegaLoc `Resize((518,518))` distorce proporção. |
| 8 | `dino-server/main.py:80` | `load_state_dict(strict=False)` aceita silenciosamente pesos faltando → backbone parcialmente carregado gera embeddings quase aleatórios com cara de plausíveis. |
| 9 | `dino-server/main.py:135,182`, `megaloc-matcher.py:103`, `geometric-reranker.py:105` | Orientação EXIF ignorada (mosaicos aplicam `.rotate()`, matchers não) → entradas inconsistentes. Baixa severidade. |
| 10 | `scripts/geometric-reranker.py:93-101, 143, 158, 164` | ≤8 imagens, ratio test 0,75 em descritor binário, modelo de homografia, saturação em 35 inliers, sem teste de espelhamento. |
| 11 | `scripts/dino-select-exteriors.py:112, 87-89` | Fica com as primeiras N fotos pela ordem do nome do arquivo, não pela confiança do CLIP; qualquer erro do servidor vira "interior" e a foto some em silêncio. |
| 12 | `make-clip-mosaics.js:214`, `make-fresh-mosaics.js:88` | `fit:'cover'` em 320×320 corta as fotos que o revisor vê. |
| 13 | `recursive-matcher-v2.py:2056, 2096-2100` | Hungarian antes de montar a lista de revisão (1 candidata por anúncio); 25% de peso no preço. |
| 14 | `CONFIRMED_PAIRS` em 6+ scripts | Copiado à mão; confirmações da interface (`review-server.js:717`) nunca voltam. |
| 15 | GT `("17378","659639")` | A mesma casa da Viva confirmada com duas da Coelho; metadados diferentes (314 vs 384 m², 1 vs 3 suítes) e a geometria só apoia 425516 (1877 inliers) → provável erro de rotulagem. |
| 16 | `scripts/prepare-next-review-round.js:77` | Lê um arquivo que não existe no repositório → o backfill de preço não faz nada, em silêncio. |

## 5. Pipeline recomendado

```
 0. Dados confiáveis ─► 1. Filtro por metadados ─► 2. Fotos reaproveitadas ─► 3. Shortlist visual
                                                                                      │
 7. Revisão humana ◄── 6. VLM (opcional) ◄── 5. Fusão + probabilidade ◄── 4. Verificação geométrica
```

**0. Dados.** Consertar os scrapers (bugs 1–2) e conferir contra o scrape de produção. Guardar por anúncio: condomínio, área construída, terreno, dorms, suítes, vagas, preço, descrição, todas as URLs de foto. Se possível, puxar o lado Coelho **do sistema interno da empresa** (fotos sem marca d'água, endereço/lote, metadados completos) — isso transforma o problema em "esta casa da Viva já está na nossa base?".

**1. Filtro e ranking por metadados, por condomínio.** Candidatas = mesmo condomínio, terreno e área construída dentro de ±15–25% (campo vazio = neutro), |dorms| ≤ 1. Pontuação por razão de verossimilhança por campo (modelo Fellegi–Sunter; a biblioteca `splink` faz isso). Preço com peso baixo. Resultado esperado: R@5 ≈ 0,90 com ~10 candidatas por anúncio, **antes de abrir qualquer imagem**.

**2. Varredura de fotos reaproveitadas em TODAS as fotos** (incluindo internas), com e sem espelhamento:
- **SSCD** (Meta, detector de cópia; MIT; roda em CPU/Mac) — robusto a corte, cor, marca d'água, sobreposição de texto.
- **PDQ** (`pdqhash`, `compute_dihedral` dá as 8 rotações/espelhamentos de graça) ou pHash (`imagehash`, já está no `requirements.txt`).
- Confirmar com SIFT/LightGlue + RANSAC. ≥2 fotos coincidentes ⇒ par praticamente confirmado. Isso já pega a metade "fácil" dos casos e gera ground truth de graça.

**3. Shortlist visual** (só para escolher *quais pares de fotos* verificar, não para decidir):
- Classificar cada foto por tipo (piscina, jardim, fachada, cozinha, sala, banheiro, planta) e comparar só tipo com tipo.
- Embeddings **SigLIP 2** + **DINOv3** por foto (≥518 px, sem recorte central, marca d'água mascarada, vetores centralizados, + versão espelhada). No benchmark ILIAS (CVPR 2025) de recuperação de instância, SigLIP superou o DINOv2.
- Opcional: **AMES** (ECCV 2024) como reranker leve sobre descritores locais.

**4. Verificação geométrica — é aqui que se decide.** Nos 3–5 melhores pares de fotos de cada par de anúncios, nos dois sentidos (original e espelhado):
- Matcher moderno: **LoMa** (ECCV 2026, MIT, feito para pares difíceis), **ALIKED/DISK + LightGlue** (Apache/BSD, roda no Mac), e **RoMa v2** (nov/2025, denso, melhor em mudança grande de ângulo/iluminação; precisa GPU) para os casos duvidosos.
- **Matriz fundamental com MAGSAC++** (`cv2.findFundamentalMat(..., cv2.USAC_MAGSAC)`), não homografia.
- Medir: nº de inliers, **espalhamento** dos inliers na imagem (inliers concentrados num pedaço só = textura repetida, tipo azulejo igual, não a mesma casa), inliers dentro da máscara da piscina.
- Máscara da piscina com **SAM 3** (prompt de texto "swimming pool"; licença Meta, uso comercial permitido) para contar inliers na piscina + borda + deck.
- Biblioteca `vismatch` (BSD‑3) embrulha 50+ matchers para testar A/B rapidamente.

**5. Fusão e calibração.** Regressão logística / Fellegi–Sunter sobre: diferenças de metadados, nº de fotos reaproveitadas, similaridade de texto da descrição, score da shortlist, inliers verificados, espalhamento. Agregar fotos→anúncio com **Hungarian entre fotos** (média dos 3 melhores pares distintos) + o máximo. Atribuição 1‑para‑1 **por condomínio** com uma coluna "sem par" de custo calibrado. Saída = **probabilidade**, não tier.

**6. VLM como desempate (opcional).** Gemini 3 Pro (`media_resolution` alta) só nos casos de fronteira: **fotos separadas em resolução cheia, nunca mosaico**; pedir 5 elementos físicos específicos presentes nas duas fotos + elementos que contradizem + metadados no texto; resposta em JSON. A literatura de 2025–26 (MMVM, VLM²‑Bench, CrossPoint‑Bench) mostra que VLMs são **fracos** em "é o mesmo objeto?" — por isso só como verificador final. Custo: ~US$ 0,005–0,01 por verificação.

**7. Tela de revisão.** Para cada anúncio Viva: top‑3 candidatas, tabela de diferenças de metadados, pares de fotos com as correspondências desenhadas, galerias sem corte, botão "não está na Coelho". Toda decisão vai para **um único `ground_truth.json`** (positivos + negativos), usado por todos os scripts.

## 6. Avaliação correta

- Um único `data/ground_truth.json` com os ~39 pares confirmados + negativos revisados; apagar as cópias de `CONFIRMED_PAIRS`.
- Rotular de forma exaustiva dentro dos blocos de metadados (76 Viva × ~10 candidatas ≈ 760 olhadas rápidas) — isso cria GT não enviesado.
- Métricas por anúncio Viva: recall@1/@3, precisão no limiar escolhido, acerto em "não tem par".
- Ajustar em Alphaville 1, **testar em Tamboré XI** (nunca ajustar e testar no mesmo conjunto).

## 7. O que fazer primeiro

**Fim de semana:**
1. Consertar o scraper (bugs 1–2), re‑raspar, comparar com o JSON de produção.
2. Script de ranking por metadados (~100 linhas) → candidatas por anúncio. R@1 ≈ 0,7 / R@5 ≈ 0,9 imediato.
3. Varredura pHash/PDQ + SSCD em **todas** as fotos, com versão espelhada, confirmação por SIFT/LightGlue.
4. `ground_truth.json` único; corrigir avaliador das rodadas (bug 6); revisar 17378↔659639.
5. Mascarar a faixa da marca d'água; tela de revisão com top‑3 e `fit: contain`.

**Projetos de semanas:**
- Etapa de verificação com LoMa / LightGlue / RoMa v2 + MAGSAC + espelhamento.
- Máscaras de piscina com SAM 3 e matching restrito à piscina.
- Modelo de fusão calibrado + similaridade de texto (`multilingual-e5-large` ou `BGE-M3`, ambos MIT).
- Integração com o sistema interno da Coelho.
- Com ≥300 pares confirmados: fine‑tuning contrastivo de DINOv3/SigLIP 2 com negativos difíceis do mesmo condomínio (antes disso, vai sobreajustar). Ideia barata antes: tratar fotos do *mesmo anúncio* como positivas (auto‑supervisão "uma casa = uma instância").

## 8. O que NÃO vale mais a pena

- Mais ensembles de embeddings globais (DINO/CLIP/mosaicos/patch‑VLAD/tiers sobre cosseno) — o teto é baixo sem verificação local.
- Modelos de reconhecimento de lugar (MegaLoc, SALAD, BoQ, AnyLoc) como **decisão** — foram treinados para ruas; servem no máximo como sinal de shortlist.
- ORB/AKAZE + homografia — trocar, não ajustar.
- VLM em mosaico ou como pontuador principal.
- Fine‑tuning com 20–100 pares.
- Descritores de forma da piscina (Hu moments) como confirmação — as piscinas desses condomínios são quase todas retangulares; no máximo servem para *rejeitar*.
- Reconstrução 3D (VGGT, MASt3R‑SfM) — pesada e, em geral, com pesos não comerciais.

## 9. Licenças (uso comercial)

- **Liberados:** LightGlue/DISK (Apache), ALIKED (BSD‑3), XFeat (Apache), LoMa (MIT/Apache), RoMa v2 (código MIT + licença DINOv3), AMES (Apache), SSCD (MIT), MegaLoc/BoQ/EigenPlaces (MIT), Florence‑2 (MIT).
- **Licença própria da Meta, comercial permitido (revisar termos):** DINOv3, SAM 3.
- **Evitar:** pesos do SuperPoint (não comercial), MASt3R/DUSt3R (CC BY‑NC‑SA), pesos do GIM ("research only"), SALAD/CliqueMining (GPL‑3); EfficientLoFTR exige registro gratuito do projeto.

## Fontes principais

LoMa github.com/davnords/LoMa · RoMa v2 github.com/Parskatt/RoMaV2 · LightGlue github.com/cvg/LightGlue · XFeat github.com/verlab/accelerated_features · vismatch github.com/alexstoken/image-matching-models · ILIAS vrg.fel.cvut.cz/ilias (CVPR 2025) · AMES github.com/pavelsuma/ames · SAM 3 github.com/facebookresearch/sam3 · SSCD github.com/facebookresearch/sscd-copy-detection · pdqhash pypi.org/project/pdqhash · splink pypi.org/project/splink · Berton et al., "All You Need to Know About Training Image Retrieval Models" (arXiv 2503.13045) · MMVM (arXiv 2501.04670) · CrossPoint‑Bench (arXiv 2512.04686).

_Alguns detalhes de artigos de 2025–26 vieram de READMEs e resumos (o arXiv estava bloqueado no ambiente da pesquisa); confirmar antes de depender deles._
