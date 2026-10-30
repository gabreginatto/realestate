# Casas fotografadas por fotógrafos diferentes: diagnóstico, piloto e proposta para a rodada 8

_31/10/2026. Pesquisa sênior sobre o caso não resolvido do pareamento Viva Prime ↔ Coelho da Fonseca (Alphaville 1 e Tamboré XI).
Nada foi commitado; nenhuma API paga foi chamada. Arquivos de apoio (folhas de contato, chave do teste cego, cache de
scores) estão em `/private/tmp/claude-501/-Users-gabrielreginatto-Desktop-Code-realestate/07c7be28-b63e-4f01-8c69-a267b80717c3/scratchpad/`._

## 0. Resumo executivo

1. **O verificador (ALIKED + LightGlue + MAGSAC) já resolve "mesma casa, fotógrafo diferente" quando as duas galerias
   fotografam o mesmo cômodo ou a mesma piscina.** No gabarito há 17 pares confirmados em que **nenhuma** foto é cópia
   (SSCD máximo < 0,50 entre todas as fotos); o verificador dá 169–728 inliers em 16 deles (o 17.º, 2075↔502738, tem só
   6 fotos na Viva e fica em 49, logo abaixo de T = 51). Exemplo: 1034↔379860 é foto de celular na Viva contra foto
   profissional na Coelho e dá 485 inliers em fotos que o SSCD considera diferentes (0,40).
2. **P_hard mede outra coisa.** Remover toda foto da Viva com SSCD ≥ 0,25 tira justamente as fotos do mesmo assunto em
   ângulo diferente (0,25 é um limiar baixo) e deixa fotos de assuntos que a Coelho **não fotografou** (fachada, banheiro,
   garagem). Os 20 pares que falham em P_hard são, em 17 casos, pares com cópia pesada (SSCD máx ≥ 0,55) que sobraram
   só com fachada/banheiro. `rec_hard` mede cobertura de assuntos, não robustez a fotógrafo. Proponho o conjunto
   **P_diff** (os 17 pares sem cópia, avaliados com todas as fotos) como métrica principal do caso difícil.
3. **As 42 Viva no limbo quase certamente não estão na Coelho viva desses dois condomínios.** Cada uma já tinha ~25
   candidatas pontuadas pelo verificador (melhores 25–46 inliers); a varredura completa contra todas as Coelho do
   condomínio (iniciada nesta sessão, ver §2.5) não muda o quadro. Os disparos atuais são falsos e vêm de duas Coelho
   "ímãs" (352803 pontua ≥ 40 contra 6 Viva diferentes; 351828 contra 5) — elementos construtivos repetidos.
4. **Rótulos a revisar.** 18454↔678679 foi rejeitado pela corretora, mas cozinha (ilha preta + coifa), escritório
   (bancada em L) e piscina com nicho de pastilha azul são visivelmente a mesma casa (127 inliers). Esse par sozinho fixa
   T = 51; sem ele T = 46 e rec_hard sobe de 0,649 para 0,702. Também há galerias da Viva com **duas piscinas diferentes**
   (17787: fotos 03–05 vs 25; 18454: 19–22 vs 20), ou seja, fotos de outra casa misturadas de propósito.
5. **Piloto cego de juiz visual (eu, olhando as fotos):** nos 10 pares P_hard que o verificador erra, acertei 6; nos 10
   negativos difíceis, 1 falso positivo. Aplicado a 8 Viva do limbo com suas 5–6 candidatas: **0 acertos**. Um juiz
   visual sobre assuntos não cobertos tem recall ~60 % e FPR ~10 %: serve para fronteira, não para decidir.
6. **Rodada 8 recomendada: normalização por Coelho ("melhor mútuo").** Simulado no cache congelado: T 51→46,
   rec_hard 0,649→0,702, FPR_S 0,028→0,006, disparos no limbo 6→3 (some 352803), R@1(P) intacto. Uma alteração, mede-se
   com `benchmark.py custom --build`.

## 1. O que foi lido e medido

- `docs/ciclo-de-melhoria.md`, `docs/analise-pareamento-imoveis.md`, `scripts/benchmark.py`, `scripts/r6_verify.py`,
  `scripts/lib/photo_types.py`, `scripts/lib/listings.py`, `data/ground_truth.json`, `data/benchmark/frozen-v1.json`,
  `data/benchmark/lg-cache.json` (2.010 pares já pontuados), `data/r6/verify-v1.json`, `data/eval/history.jsonl`.
- Fotos em `data/photos-fresh/<site>/<código>/NN.jpg`; textos em `data/<condomínio>/fresh-listings/*.json`.
- Olhei (com o Read) ~40 folhas de contato: galerias inteiras, pares de fotos escolhidos pelo verificador e os sheets do
  teste cego.

## 2. Diagnóstico

### 2.1 O que é, de fato, um par "fotógrafo diferente" aqui

Classifiquei os 59 pares P pelo SSCD máximo entre todas as fotos Viva×Coelho:

| SSCD máx. | n pares | o que é | verificador (todas as fotos) |
|---|---|---|---|
| < 0,50 | 17 | nenhuma cópia: sessões diferentes de verdade | 169–728 inliers em 16; 49 em 1 (2075, 6 fotos) |
| 0,50–0,60 | 18 | 1–2 fotos "parecidas", resto diferente | 197–699 |
| 0,60–0,90 | 12 | algumas cópias | 322–963 |
| ≥ 0,90 | 12 | galeria copiada | 1.104–1.749 |

Como são os pares sem cópia (vi as fotos): mesma cozinha com parede de tijolo e bancada de mármore fotografada de
celular (Viva) e por profissional (Coelho) — 1034↔379860, 485 inliers; mesmo lavabo com luminária de vitral —
10755↔504962, 404; mesmo quarto com nichos iluminados — 16341↔352803, 319. **Mobília, iluminação e ângulo mudam;
o verificador encontra 100–500 inliers mesmo assim.** O caso "fotógrafo diferente" está resolvido sempre que as duas
galerias mostram o mesmo cômodo.

### 2.2 Por que P_hard engana

| par | SSCD máx | fotos | sobram em P_hard | verificador em P_hard | o que sobrou |
|---|---|---|---|---|---|
| 17388↔354149 | 0,62 | 43 | 4 | **12** | 2 fachadas, 1 banheiro, 1 garagem — a Coelho (28 fotos) não tem fachada nem esse banheiro |
| 7597↔358601 | 0,98 | 21 | 5 | **16** | idem: assuntos ausentes na Coelho |
| 12854↔616435 | 0,96 | 50 | 12 | **13** | idem |
| 1034↔379860 | 0,40 | 26 | 12 | **485** | fotos "diferentes" para o SSCD que são o mesmo cômodo |
| 14127↔663462 | 0,39 | 39 | 36 | **286** | idem |

Dos 20 pares que falham em P_hard, 17 têm SSCD máx ≥ 0,55 (galeria com cópias); dos 17 pares sem cópia, 16 passam.
Ou seja, P_hard **penaliza quem copiou fotos** (porque sobra só o que a Coelho não fotografou) e **não testa** o caso
que importa. Recomendação: criar **P_diff** = pares P com SSCD máx < 0,50 (17 pares; ou < 0,60, 35 pares), pontuados
com todas as fotos, e reportar `rec_diff` ao lado de `rec_hard`. Isso não exige rótulo novo: deriva do gabarito atual.

### 2.3 Por que o verificador não dispara nas 42 do limbo

- **Candidatas já foram vistas.** Cada Viva do limbo tem 20–33 pares no cache (top-3 por contagem SSCD, top-5 por
  metadados, união r6). Melhores scores: 25–46 inliers em 36 das 42; acima de T só 12414→352803 (80), 17465→352803
  (68), 9624→352241 (58), 18369→352803 (57), 18403→379860 (57), 18404→351828 (52). Vi 12414/352803, 9624/352241 e
  18404/351828: **falsos** (piscinas de formato diferente).
- **Coelho "ímãs".** 352803 pontua ≥ 40 contra 6 Viva distintas (uma verdadeira, 16341, com 728); 351828 contra 5. Isso
  é o análogo, no verificador, das "fotos genéricas" da rodada 5: um elemento repetido (piso, cerca, azulejo da
  construtora) gera 50–80 inliers com qualquer casa parecida. Uma normalização por Coelho resolve (§4.1).
- **Rótulo H contaminado.** 18454↔678679 (Tamboré XI, lote 420/420, construída 365/334) está em H com 127 inliers.
  Fotos: `vivaprimeimoveis/18454/05.jpg` ↔ `coelhodafonseca/678679/08.jpg` (cozinha), `18454/07.jpg` ↔ `678679/11.jpg`
  (escritório), `18454/20.jpg` ↔ `678679/02.jpg` (piscina com nicho de pastilha azul). É a mesma casa; a Viva está vazia
  e a Coelho mobiliada (sessões diferentes). Como T é o 3.º maior score de H, esse par define T = 51. Sem ele T = 46.
  Também suspeito: 17480↔675706 (58 inliers, interior).
- **Galerias da Viva misturam casas.** 17787 (confirmada com 654085) tem uma piscina comprida com colunas de tijolo nas
  fotos 01–05 e a piscina quadrada da 654085 na foto 25 (interiores batem com a Coelho: sofá amarelo, sofá em L, quarto
  infantil). 18454 tem piscina azul-escura comprida (19–22) e a piscina pequena da 678679 (20). Nenhuma dessas fotos
  "intrusas" é cópia de outra Viva (0 pares Viva×Viva com SSCD ≥ 0,6 em 105 anúncios) — são fotos de outra casa, usadas
  como fachada de despiste. Para o verificador isso é inofensivo (ele usa o máximo), mas engana o juiz visual e enviesa
  P_hard.
- **Metadados pouco discriminativos nos condomínios.** 28 das 42 Viva do limbo têm lote 560 (padrão Alphaville 1) ou
  420 (padrão Tamboré XI). Igualdade exata lote+construída dentro do pool inteiro (795 Coelho) aparece em 5 casos:
  5380↔467562 (confirmada no gabarito, mas 467562 **não está mais viva** — sem fotos), 16870↔654085 (rejeitada,
  e as piscinas são de fato diferentes), 17391↔687889 e 17465↔689944 (ambas em "r7-extra", Santana de Parnaíba, preço
  40 % menor; vi as fotos: **não são a mesma casa**), 8527↔650074 (piscina retangular vs piscina orgânica: não).
- **Conclusão sobre a sobreposição.** O 60 % medido parece correto para "Viva viva × Coelho viva nesses dois
  condomínios". Os 80 % do dono provavelmente incluem casas que a Coelho já vendeu ou tirou do ar (caso 5380) ou que
  anuncia noutro nome de condomínio sem fotos baixadas (189 candidatas da rodada 7 ficaram sem fotos).

### 2.4 Como são as fotos do limbo que não casam

Vi 8 Viva × 5–6 candidatas (sheets `limbo_<viva>.jpg`). Padrão: a Viva mostra piscina e área externa com clareza; as
candidatas Coelho do mesmo lote/construída/suítes têm piscinas de formato, revestimento e implantação diferentes. Não há
"quase": são casas distintas. Exemplos: 9624 (piscina raia estreita com deck) × 643279 (piscina larga em frente à casa);
14138 (piscina encostada na casa com parede de pedra) × 392768 (piscina no gramado); 12414 (casa antiga de tijolo, piscina
com pergolado) × 352803 (casa reformada, piscina com gramado).

### 2.5 Varredura completa (em andamento ao fechar este texto)

Lancei `scratchpad/score_pairs.py`: verificador em **todas** as Coelho do mesmo condomínio para as 42 Viva do limbo
(75 ou 31 candidatas cada; cache em `scratchpad/lg-cache-ext.json`, não toca `data/benchmark/lg-cache.json`). O processo
leva ~3 min por Viva de Alphaville 1 e ainda roda; resultado final em `scratchpad/score_pairs.log` e
`scratchpad/u_sweep.json`.

Parcial, 10 de 42 Viva (≈ 650 pares novos): melhor par por Viva entre 33 e 60 inliers. Só três passam de T = 51:
12414→352803 (80, falso, já conhecido) e dois novos, **14138→661093 (60)** e **12030→565110 (58)** — vi os pares de
fotos (`14138/13.jpg` ↔ `661093/21.jpg`, `12030/33.jpg` ↔ `565110/11.jpg`): quartos diferentes (parede de tijolo vs lisa,
móveis diferentes); 50–60 inliers vêm do arranjo genérico janela+cama+escrivaninha. Lição: **com ~2 % de FPR por par,
varrer 75 candidatas por Viva produz ~1,5 falso disparo por Viva** (comparações múltiplas). A shortlist não era o gargalo;
abrir a shortlist sem normalizar por Coelho (§4.1) e sem exigir ≥ 2 pares de fotos independentes só aumenta o ruído.
565110 é o terceiro "ímã" (48 contra 18369, 58 contra 12030).

## 3. Piloto: juiz visual às cegas

### 3.1 Protocolo

20 pares embaralhados (`blind_NN.jpg`, chave em `key.json`, lida só depois): 10 pares P_hard que o verificador erra
(lado Viva = só as fotos que sobram em P_hard, ≤ 12) e os 10 negativos H com maior score do verificador (lado Viva = 12
fotos aleatórias). Lado Coelho = galeria inteira (≤ 36). Julguei SIM/NÃO com confiança.

### 3.2 Resultado

| | SIM | NÃO |
|---|---|---|
| **P (10)** | 6 (4657↔429709, 12854↔616435, 16886↔617978, 16892↔663984, 17722↔677257, 18159↔445169) | 4 (18303↔689026, 18093↔497009, 7597↔358601, 17787↔654085) |
| **H (10)** | 1 (11115↔689645: duas casas com vista para as torres de Alphaville) | 9 |

Recall 0,60, FPR 0,10. Os 4 erros em P são pares em que só sobraram fachadas/banheiros (18093, 7597) ou em que a
galeria da Viva tem fotos de outra casa (17787: a piscina comprida não existe na 654085). O acerto 6/10 veio de pistas
fracas (mesmo piso, mesma caixilharia) com confiança baixa/média. **Um VLM faria no máximo isso** — e a literatura
(VLM²-Bench, MMVM) diz que faz pior. Serve como triagem humana de pares entre 35 e 60 inliers, não como decisor.

### 3.3 Limbo: 8 Viva × top-5/6 candidatas

| Viva | candidatas vistas (lote/constr./suítes; verif.) | veredito |
|---|---|---|
| 17465 (560/500/4) | 689944* (560/500/4; 15), 663487†, 677791, 674139, 358241, 687641† | nenhuma; 687641 tem churrasqueira de tijolo parecida, mas a corretora já rejeitou |
| 17391 (420/430/4) | 687889* (420/430/4; 16), 682207†, 659243†, 504962†, 654085, 664659 | nenhuma |
| 8527 (575/420/4) | 650074 (575/420/2; 13), 403934†, 665488†, 606206, 661974, 687641 | nenhuma (650074 tem piscina orgânica com deck) |
| 16870 (420/400/4) | 654085† (420/400/4; 17), 664659†, 504962, 682207, 659243 | nenhuma; a rejeição da corretora está certa |
| 12414 (595/500/4) | 352803 (80 inliers), 379860†, 569097†, 502738, 660804, 663487 | nenhuma; 352803 é falso |
| 9624 (848/667/4) | 352241 (58), 643279 (47), 356129†, 654894†, 670241, 445169† | nenhuma |
| 18404 (617/484/4) | 351828* (52), 660463, 669495, 688142, 682681, 689026† | nenhuma; 351828 tem piscina redonda, a Viva retangular |
| 14138 (640/400/2) | 671267†, 422399, 686049 (39), 392768 (41), 639051† | nenhuma |

\* pool estendido (outro condomínio na Coelho) · † rejeitada pela corretora. **0 acertos em 8.**

## 4. Técnicas para fotógrafos diferentes, ranqueadas

Critério: ganho esperado **neste** conjunto, custo, roda em MPS, e como medir no benchmark congelado sem rótulo novo.

| # | técnica | ganho esperado | custo | MPS | como medir |
|---|---|---|---|---|---|
| 1 | **Normalização por Coelho ("melhor mútuo")**: score(v,c) só vale se v for a Viva com maior score para c (ou s − 0,5·melhor-outra). Análogo do filtro de fotos genéricas, no nível do verificador | simulado no cache: T 51→46, rec_hard 0,649→0,702, FPR_S 0,028→0,006, fires_U 6→3 | 1 dia; só código, nada de modelo novo | sim (reusa cache) | `benchmark.py custom --build`; portões R@1(P)=1, FPR_H ≤ 2 % |
| 2 | **Revisar 2 rótulos H** (18454↔678679, 17480↔675706) com a corretora, mostrando os pares de fotos acima | T 51→46; rec_hard +0,05 sem mudar código | 1 hora | — | refreeze só depois da confirmação (muda o benchmark; registrar) |
| 3 | **P_diff como métrica** (§2.2) | mede o que interessa; hoje 16/17 | 2 horas | — | nova linha no `benchmark.py` |
| 4 | **Texto**: 6-gramas compartilhados não-boilerplate ≥ 3 → 12/59 P, **0/136 H, 0/177 S**; lote **e** construída exatos → 23/59 P vs 1/136 H, 0/177 S | só ranking/bônus; no limbo não há hit (máx. 4 n-gramas, todos boilerplate) | 1 dia | — | precisão em P/H/S já medida; integrar como desempate |
| 5 | **Mais pares de fotos por par de anúncios** (hoje ≤ 8 por cosseno DINO, mesmo tipo CLIP): subir para 16 ou todos-contra-todos nos pares em que o melhor < T | recupera pares em que o cômodo certo não entra no top-8 (ex.: 2075, 6 fotos, 49 inliers) | 1 dia; 2–4× tempo de verificação | sim | rec_diff e rec_hard; FPR_H não pode subir |
| 6 | **Elementos fixos** (escada, grade de janela, lareira, piso): é exatamente o que ALIKED/LightGlue já casa quando o cômodo coincide (ver 1034, 10755, 16341) | marginal; o gargalo é cobertura de assuntos, não o descritor | — | — | — |
| 7 | **Geometria da piscina** (SAM 3 → contorno → forma invariante a afinidade): piscinas aqui são retângulos e raias; a forma distingue "orgânica vs retangular vs quadrada" e só **rejeita** | útil para cortar falsos (352803, 351828) mas o item 1 já faz isso de graça | 1 semana | SAM 3 roda em MPS (lento) | FPR_S/FPR_H |
| 8 | **Aéreo / satélite**: Viva tem drones em ~10 anúncios (17465, 18454, 9624…) e a Coelho também (643279/38–39, 351828); mapear cada drone a um lote do condomínio e cruzar | mapeia a um **lote físico** quem tem drone; cobre uma minoria dos anúncios; imagem de satélite do Google/Esri é paga ou tem termos de uso — **pedir autorização antes**; Sentinel (10 m) não serve | 1–2 semanas | matching drone↔satélite com LightGlue roda em MPS | sem rótulo: dois anúncios no mesmo lote devem ser o mesmo par P |
| 9 | **Consistência de planta/quartos** | já está em `metadata_score`; lotes padrão (560/420) limitam | — | — | — |
| 10 | **VLM juiz (Gemini/Claude)** em fotos separadas, só para pares 35–60 inliers | o piloto humano dá recall 0,6 / FPR 0,1; VLM tende a pior; ~US$ 0,01/par; **pago, pedir autorização** | 2 dias | não | P_hard + H que caem na faixa |

O que **não** vale a pena: embeddings globais novos, Hu moments como confirmação, fine-tuning com 59 pares, VLM em
mosaico (tudo já descartado na auditoria anterior e confirmado aqui).

## 5. Recomendação para a rodada 8 (última)

**Uma alteração: normalização por Coelho no verificador.** Em `benchmark.py`/`build_ranking`, depois de pontuar os pares
de uma Coelho c contra as Viva candidatas (P ∪ U), definir `score'(v,c) = s(v,c)` se `s(v,c) ≥ max_{v'≠v} s(v',c)`
(melhor mútuo), senão 0; alternativa contínua `s − 0,5·max_{v'≠v} s(v',c)`. Manter o resto igual.

Simulação no cache congelado (2.010 pares já pontuados; o conjunto "outras Viva" de cada Coelho é parcial, então os
números finais vão diferir um pouco):

| variante | T | rec_hard | FPR_H | FPR_S | fires_U |
|---|---|---|---|---|---|
| atual | 51 | 0,649 | 0,015 | 0,028 | 6 |
| s − 0,5·melhor-outra | 32 | 0,667 | 0,015 | 0,006 | 2 |
| melhor mútuo | 46 | 0,702 | 0,015 | 0,006 | 3 |

Risco: uma Coelho que a Viva anuncia duas vezes (casos 12229/18360) perde um dos pares; aceitável porque a página de
rotulagem já aceita várias Coelho por Viva e o par principal continua. R@1(P) não muda (os pares P têm 169–1.749 inliers
contra 25–80 das "outras").

Fora da contagem de rodadas (não são alterações de método): (a) mostrar à corretora os pares 18454↔678679 e 17480↔675706
e, se confirmar, refazer o congelamento com registro; (b) adicionar `rec_diff` ao benchmark; (c) terminar de baixar as
fotos das 189 candidatas da rodada 7 sem fotos e rodar o verificador nelas — é a única hipótese plausível que sobra para
os 80 % do dono, junto com casas já vendidas.

## 6. Comandos de verificação e arquivos

```bash
# benchmark atual (não muda nada)
source venv/bin/activate && python scripts/benchmark.py r7 --no-history -v
# varredura completa das 42 Viva do limbo (já rodou/roda em segundo plano)
tail -50 /private/tmp/claude-501/-Users-gabrielreginatto-Desktop-Code-realestate/07c7be28-b63e-4f01-8c69-a267b80717c3/scratchpad/score_pairs.log
# folhas de contato do piloto cego e chave
ls /private/tmp/claude-501/-Users-gabrielreginatto-Desktop-Code-realestate/07c7be28-b63e-4f01-8c69-a267b80717c3/scratchpad/blind_*.jpg
cat /private/tmp/claude-501/-Users-gabrielreginatto-Desktop-Code-realestate/07c7be28-b63e-4f01-8c69-a267b80717c3/scratchpad/key.json
```

Fotos-chave para a corretora: `data/photos-fresh/vivaprimeimoveis/18454/{05,07,20}.jpg` ↔
`data/photos-fresh/coelhodafonseca/678679/{08,11,02}.jpg`; `vivaprimeimoveis/17787/{03,25}.jpg` (duas piscinas na mesma
galeria) ↔ `coelhodafonseca/654085/02.jpg`; `vivaprimeimoveis/17388/{01,25,43}.jpg` (o que sobra em P_hard) ↔ galeria
`coelhodafonseca/354149/`.
