// ============================================================================
//  FONTE REAL — GÊMEO DIGITAL dirigido pelos sinais da linha.
//
//  Assina o broker MQTT e traduz o RealPayload do gateway para o MESMO
//  RobotState que o simulador emite — o cliente não sabe a diferença.
//
//  DECISÃO DE PROJETO: não lemos os ângulos do robô (o YRC1000 não os manda ao
//  CLP). O movimento é GERADO aqui, com a cinemática real do GP12, e quem
//  decide QUANDO cada trecho acontece são os SINAIS DA LINHA:
//
//    vácuo liga  -> pegou: o braço sobe e parte para o palete
//    vácuo cai   -> soltou: a caixa entra na pilha e o braço recua
//    contador    -> qual slot do catavento é o destino
//    balança     -> quando a caixa está pronta para a pega
//
//  O resultado: os EVENTOS são reais, o movimento entre eles é interpolado.
//  Nenhum instante é inventado; o que se preenche é só o caminho.
//
//  A pilha também é derivada dos contadores com as mesmas tabelas do padrão —
//  o CLP não transmite posição de caixa nenhuma.
// ============================================================================
import { EventEmitter } from "node:events";
import mqtt from "mqtt";
import type { PlacedBox, RealPayload, RobotState } from "../shared/types.js";
import { fkTcp, route, slot, PER_PALLET, TOTAL, PICK, FEED, PHASES } from "./simulator.js";
import { Ptp } from "./ptp.js";

// O gateway manda sinal de vida a cada 1 s (VIDA_MS lá). Cinco segundos aqui
// aguentam um engasgo de rede sem piscar SEM DADOS REAIS na cara do operador,
// e ainda denunciam um caminho morto em cinco segundos.
const FRESCOR_MS = 5000;
const TICK_MS = 40;                 // 25 Hz: o mesmo passo do simulador na rede

export class MqttSource extends EventEmitter {
  private last: RealPayload | null = null;
  private lastRx = 0;
  private timer: NodeJS.Timeout;

  // ---- o gêmeo ----
  private ptp = new Ptp();
  private wp = 0;                   // índice no roteiro de route()
  private carregando = false;       // a caixa está na ventosa?
  private naBalancaPrev = false;    // para detectar a borda de saída
  private qtdPrev = -1;             // para detectar o depósito
  private vacuoPrev = false;        // o vácuo é NÍVEL: precisa de borda
  private tCarregando = 0;          // s carregando — rede de segurança
  // ---- a caixa vindo pela esteira ----
  private feedX: number | null = null;   // posição no eixo da linha, ou null
  private sensorPrev = false;            // borda do SP3 (esteira de entrada)
  // ---- os paletes indo embora na empilhadeira ----
  private pal = {
    A: { pres: null as boolean | null, saida: 1, cheio: false, usado: false },
    B: { pres: null as boolean | null, saida: 1, cheio: false, usado: false },
  };
  private tcpPrev: { x: number; y: number; z: number } | null = null;
  private tcpSpeed = 0;

  constructor(
    url = process.env.MQTT_URL ?? "mqtt://localhost:1883",
    topico = process.env.MQTT_TOPICO ?? "multilaser/paletizadora/r01/estado",
  ) {
    super();

    // Broker mal configurado NÃO derruba a aplicação: o simulador tem de
    // continuar servindo. A fonte real simplesmente nasce morta, e a tela
    // mostra SEM DADOS REAIS — que é a verdade.
    if (!/^(mqtt|mqtts|ws|wss|tcp|ssl):\/\//.test(url)) {
      console.error(
        `[fonte-real] MQTT_URL invalida ("${url}"): falta o protocolo. ` +
        `Use algo como mqtts://seu-cluster.hivemq.cloud:8883. ` +
        `A fonte REAL fica indisponivel; o SIMULADOR segue funcionando.`);
      this.timer = setInterval(() => this.emit("state", this.snapshot()), TICK_MS);
      return;
    }

    // Credencial separada da URL: senha com caractere especial (@ : / #) não
    // sobrevive dentro de uma URL, e não é a senha que deve ceder.
    const client = mqtt.connect(url, {
      reconnectPeriod: 3000,
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASS,
    });
    client.on("connect", () => {
      console.log(`[fonte-real] broker OK: ${url} (tópico ${topico})`);
      client.subscribe(topico);
    });
    client.on("error", (e) => console.error(`[fonte-real] broker: ${e.message}`));
    client.on("message", (_t, raw) => {
      // Mensagem de rede: parse defensivo, campos validados no uso.
      try {
        const p = JSON.parse(String(raw)) as RealPayload;
        if (p && p.robo && p.celula && p.passos) {
          this.last = p;
          this.lastRx = Date.now();
        }
      } catch { /* malformada: ignora */ }
    });

    this.timer = setInterval(() => {
      this.tick(TICK_MS / 1000);
      this.emit("state", this.snapshot());
    }, TICK_MS);
  }

  get ok(): boolean {
    return this.last !== null
      && Date.now() - this.lastRx < FRESCOR_MS
      && this.last.plcOk;
  }

  /** UM contador serve aos dois paletes: a célula fecha um e começa o outro,
   *  e os bits LADO 1/2 ATIVO dizem de quem ele é. Isto é o ROTEAMENTO — em
   *  que caixa o robô está trabalhando. Vem só dos sinais, sem memória: é o
   *  que aponta o braço, e apontar errado é o pior defeito possível. */
  private roteamento(p: RealPayload) {
    const qtd = Math.max(0, Math.min(PER_PALLET, p.qtdeLado1));
    const noLado2 = p.robo.lado2 && !p.robo.lado1;
    return { noLado2, qtd, boxIndex: (noLado2 ? PER_PALLET : 0) + qtd };
  }

  /** Quantas caixas há EM CIMA de cada palete, para desenhar.
   *
   *  Diferente do roteamento, e o motivo é físico: o lado que o robô não está
   *  atendendo tem ou um palete CHEIO esperando a empilhadeira, ou um palete
   *  vazio recém-posto. O contador do CLP não distingue os dois — ele só fala
   *  do lado ativo. Quem distingue é a memória de `pal`: o robô paletizou
   *  ali e o sensor de presença não caiu desde então, logo está cheio.
   *
   *  A versão anterior chutava: lado A inativo = cheio, lado B inativo = 0.
   *  Assimétrico, e errado na volta para o lado 1 — o palete B cheio sumia
   *  da tela no mesmo quadro, sem empilhadeira nenhuma. */
  private contagens(p: RealPayload) {
    const { noLado2, qtd } = this.roteamento(p);
    const parado = (l: "A" | "B") => (this.pal[l].cheio ? PER_PALLET : 0);
    return {
      noLado2,
      countA: noLado2 ? parado("A") : qtd,
      countB: noLado2 ? qtd : parado("B"),
    };
  }

  // --------------------------------------------------------------------------
  //  O gêmeo: avança o braço conforme os sinais reais
  // --------------------------------------------------------------------------
  private tick(dt: number) {
    const p = this.last;
    if (!p || !this.ok) {
      // Sem dado fresco o braço PARA onde está — não continua sozinho
      // fingindo que a célula segue produzindo.
      this.tcpSpeed = 0;
      return;
    }

    // Os paletes vêm ANTES do desvio de emergência, e isso é de propósito:
    // tirar um palete exige abrir a porta, e abrir a porta derruba a
    // segurança. Se este trecho ficasse depois do `return`, o palete nunca
    // sairia de cena justamente na única situação em que ele sai.
    // "Ativo" sai dos bits crus, não de `noLado2`: com os DOIS bits em zero
    // (robô em home, em falha) nenhum lado é ativo, e nenhum dos dois pode
    // perder a marca de cheio por isso.
    const rota = this.roteamento(p);
    this.moveDoPalete("A", p.celula.palete1,
      p.robo.lado1 && !p.robo.lado2, rota.qtd, dt);
    this.moveDoPalete("B", p.celula.palete2,
      p.robo.lado2 && !p.robo.lado1, rota.qtd, dt);

    // EMERGÊNCIA: o robô para ONDE ESTAVA. Nada de terminar o movimento em
    // curso, nada de recolher — é o que a célula real faz quando a categoria
    // de segurança corta a potência.
    if (p.celula.emergencia) {
      this.tcpSpeed = 0;
      return;
    }

    const boxIndex = Math.min(TOTAL - 1, rota.boxIndex);
    const wps = route(boxIndex);

    // =======================================================================
    //  QUAIS SINAIS DIRIGEM O BRAÇO
    //
    //  MEDIDO NA CÉLULA REAL, com o gateway publicando:
    //
    //    peso 0 -> 1            a balança aprovou
    //    vacuoLigado -> true    o robô pegou          <- alterna certo
    //    pecaEmPosicao -> false a caixa saiu          <- alterna certo
    //    vacuoLigado -> false   comando de vácuo cai
    //    qtdeLado1 6 -> 7       depositou             <- alterna certo
    //
    //  E o `vacuoOk` (VC1) NUNCA muda: fica em false o tempo todo. A versão
    //  anterior exigia `vacuoLigado && vacuoOk`, então a condição jamais era
    //  verdadeira — a pilha crescia pelo contador e o braço ficava parado.
    //  Era esse o defeito.
    //
    //  Duas bordas dirigem o braço, e nenhuma depende de VC1:
    //    vácuo LIGA (ou a peça sai da balança)  -> pegou: sobe e parte
    //    o contador INCREMENTA                  -> depositou: recua
    // =======================================================================
    const naBalanca = p.balanca.pecaEmPosicao;
    // Só `vacuoLigado`: é o comando de vácuo, e é o que alterna de verdade.
    // O VC1 não entra — está morto no dado real (ver acima).
    const vacuo = p.robo.vacuoLigado;
    const qtd = p.qtdeLado1;

    // primeira mensagem: só sincroniza, sem inventar evento
    if (this.qtdPrev < 0) {
      this.qtdPrev = qtd;
      this.naBalancaPrev = naBalanca;
      this.vacuoPrev = vacuo;
    }

    const saiuDaBalanca = this.naBalancaPrev && !naBalanca;
    // BORDA, não nível: `vacuoLigado` fica alto durante todo o transporte, e
    // usá-lo como nível reiniciava o trecho a cada quadro — o braço oscilava
    // entre SOBE e GIRO sem sair do lugar.
    const ligouVacuo = vacuo && !this.vacuoPrev;
    const pegouAgora = saiuDaBalanca || ligouVacuo;

    // QUALQUER mudança do contador encerra o transporte — sem exigir que o
    // valor novo seja maior. A versão anterior pedia `qtd > 0`, e isso perdia
    // exatamente o evento da TROCA DE LADO: ao completar o palete 1 o
    // contador vai de 32 para 0, o depósito não era reconhecido, e o braço
    // ficava parado no slot do lado 2 sem nunca voltar. Era esse o defeito.
    // De quebra, cobre o rollback de falha (18 -> 16), que também é evento.
    const mudouContador = qtd !== this.qtdPrev;

    if (pegouAgora && !this.carregando) {
      this.carregando = true;
      this.tCarregando = 0;
      this.wp = 2;                    // SOBE, com a caixa
    } else if (pegouAgora) {
      // SEGUNDA borda da MESMA pega — e ela SEMPRE acontece: o vácuo liga
      // primeiro, e só depois a caixa deixa de tapar o sensor da balança.
      // São dois eventos, um único apanhar.
      //
      // A versão anterior refazia `wp = 2` aqui, e o braço VOLTAVA para a
      // altura de subida no meio do caminho até o palete — era esse o
      // movimento estranho no lado 1. Uma pega nova só pode existir depois
      // de um depósito, e depósito zera `carregando`; então, carregando, a
      // borda é da mesma caixa. Renova só o cão de guarda.
      this.tCarregando = 0;
    }

    if (this.carregando) {
      this.tCarregando += dt;
      // Rede de segurança: se o contador não confirmar em 25 s, algo se
      // perdeu (sinal, reconexão, caso não previsto). Solta o braço em vez
      // de deixá-lo plantado no slot para sempre.
      if (mudouContador || this.tCarregando > 25) {
        this.carregando = false;
        this.wp = 6;                  // RECUA
      }
    }
    // =======================================================================
    //  A CAIXA CHEGANDO PELA ESTEIRA
    //
    //  Antes a caixa simplesmente APARECIA sobre a balança. Agora o sensor de
    //  entrada (SP3) dispara a viagem: a caixa nasce na boca da esteira e
    //  desliza até os roletes na velocidade da correia. O atraso entre o
    //  sensor acionar e a caixa chegar de fato é o tempo real do percurso —
    //  não é enfeite, é o que acontece na linha.
    //
    //  Se a balança confirmar antes de a animação terminar (esteira mais
    //  rápida do que o estimado), a caixa é encaixada nos roletes na hora:
    //  o sinal manda, a animação obedece.
    // =======================================================================
    const sensor = p.celula.caixaNaEsteira;
    if (sensor && !this.sensorPrev && this.feedX === null && !this.carregando) {
      this.feedX = FEED.sealExit;          // boca da esteira
    }
    if (this.feedX !== null) {
      if (naBalanca) {
        this.feedX = PICK.r;               // a balança confirma: chegou
      } else if (this.feedX > PICK.r) {
        this.feedX = Math.max(PICK.r, this.feedX - FEED.vel * dt);
      }
    }
    // Saiu da balança (o robô pegou) ou está na garra: não há caixa na linha.
    if (this.carregando || saiuDaBalanca) this.feedX = null;
    // Balança ocupada sem a animação ter começado (o gêmeo entrou no meio do
    // ciclo): mostra a caixa já nos roletes, sem inventar viagem.
    if (this.feedX === null && naBalanca && !this.carregando) this.feedX = PICK.r;
    this.sensorPrev = sensor;

    this.naBalancaPrev = naBalanca;
    this.qtdPrev = qtd;
    this.vacuoPrev = vacuo;

    if (this.carregando) {
      // Percorre SOBE -> GIRO -> APROX -> DEPOSITA e espera no destino até
      // o contador confirmar. Quem diz "chegou" é a própria cinemática.
      if (this.wp < 2) this.wp = 2;
      if (this.wp < 5 && this.ptp.chegou) this.wp++;
    } else if (this.wp === 6) {
      if (this.ptp.chegou) this.wp = 0;          // terminou de recuar
    } else {
      // Livre: espera sobre a balança; desce quando a peça está liberada.
      const pronta = naBalanca && p.balanca.peso === 1;
      this.wp = pronta ? 1 : 0;
    }

    this.ptp.goTo(wps[this.wp].j);
    this.ptp.step(dt, 100);

    const t = fkTcp(this.ptp.j);
    if (this.tcpPrev) {
      this.tcpSpeed = Math.hypot(
        t.x - this.tcpPrev.x, t.y - this.tcpPrev.y, t.z - this.tcpPrev.z) / dt;
    }
    this.tcpPrev = t;
  }

  // --------------------------------------------------------------------------
  //  O PALETE INDO EMBORA
  //
  //  O sensor de presença (SP4/SP5) cair não é só "apagar o palete": é a
  //  empilhadeira entrando e levando o palete COM a pilha em cima. Aqui se
  //  cronometra essa saída, e o cliente só interpola.
  //
  //  Tem uma segunda consequência, menos óbvia. UM contador serve aos dois
  //  paletes, e enquanto o robô trabalha no lado 2 o lado 1 é reportado como
  //  cheio (32). Se o operador tira o palete 1 e põe um vazio no lugar, o
  //  contador não muda nada — a tela redesenharia 32 caixas sobre um palete
  //  que acabou de chegar vazio. Por isso o lado retirado fica marcado, e
  //  volta a contar só quando o robô de fato voltar a paletizar nele.
  // --------------------------------------------------------------------------
  private static readonly SAIDA_S = 2.2;   // o tempo da empilhadeira sair

  private moveDoPalete(
    lado: "A" | "B", presente: boolean, ativo: boolean, qtd: number, dt: number,
  ) {
    const e = this.pal[lado];

    // Primeira mensagem: só sincroniza. Sem palete no sensor não se inventa
    // uma saída que ninguém viu acontecer.
    if (e.pres === null) {
      e.pres = presente;
      e.saida = presente ? 0 : 1;
      // Palete presente num lado que o robô NÃO está atendendo: é o que ele
      // acabou de fechar. A célula alterna 1 e 2, então essa é a leitura de
      // longe mais provável — e é a única que faz a tela abrir certa no meio
      // de um turno.
      e.cheio = presente && !ativo;
    }

    if (e.pres && !presente) {            // borda de queda: a empilhadeira entrou
      e.saida = 0;
      e.usado = false;
      // `cheio` NÃO cai aqui: a carga está saindo EM CIMA do palete e
      // precisa continuar desenhada durante o trajeto. Zerar na borda fazia
      // o palete atravessar a cena vazio e as 32 caixas evaporarem no lugar.
    }
    if (!e.pres && presente) e.saida = 0; // palete novo no lugar
    e.pres = presente;

    if (!presente && e.saida < 1) {
      e.saida = Math.min(1, e.saida + dt / MqttSource.SAIDA_S);
      // Saiu de cena: agora sim a carga deixou de existir aqui. Um palete
      // novo entra vazio, mesmo com o contador do CLP marcando 32.
      if (e.saida >= 1) e.cheio = false;
    }
    if (presente) e.saida = 0;

    if (ativo) {
      // O robô está paletizando aqui: o contador do CLP é deste lado.
      e.cheio = false;
      if (qtd > 0) e.usado = true;
    } else if (e.usado) {
      // Acabou de deixar de ser o lado ativo depois de ter recebido caixas:
      // o que ficou ali é um palete CHEIO, e ele fica visível até alguém
      // levar. Sem isto, fechar o palete fazia a pilha evaporar na troca.
      e.cheio = true;
      e.usado = false;
    }
  }

  /** A pilha reconstituída dos contadores, pelas mesmas tabelas do padrão. */
  private pilha(a: number, b: number): PlacedBox[] {
    const out: PlacedBox[] = [];
    for (let i = 0; i < Math.min(a, PER_PALLET); i++) {
      const s = slot(1, i);
      out.push({ ...s.center, rot: s.rot });
    }
    for (let i = 0; i < Math.min(b, PER_PALLET); i++) {
      const s = slot(-1, i);
      out.push({ ...s.center, rot: s.rot });
    }
    return out;
  }

  snapshot(): RobotState {
    const p = this.last;
    const ok = this.ok;

    if (!p) {
      // Nunca chegou nada: estado vazio e explícito.
      return {
        j: [0, -5, -50], phase: 0, phaseName: "SEM DADOS", carrying: false,
        feed: null, peso: 0, running: false, ritmo: 0, turbo: 1,
        fonte: "real", realOk: false, tcp: fkTcp([0, -5, -50]), speed: 0,
        placed: [], boxIndex: 0, boxTotal: TOTAL, descartadas: 0, carryRot: 0,
        paleteA: false, paleteB: false, saidaA: 1, saidaB: 1,
        emergencia: false, paletesProduzidos: 0,
        status: {
          remoto: false, servoOn: false, emCiclo: false, emHome: false,
          falha: false, almRobo: 0, automatico: false, portas: false,
          barreiras: false, descargaCheia: false, vacuoLigado: false,
          vacuoOk: false, pressaoBar: 0, ladoAtivo: 0, almBalanca: 0,
          seladoraDesabilitada: false,
        },
        countA: 0, countB: 0,
      };
    }

    const { countA, countB } = this.contagens(p);
    // O braço é apontado pelo ROTEAMENTO, que sai direto dos bits de lado.
    // A contagem visível não entra aqui: um palete retirado zera o desenho
    // daquele lado, e se isso mexesse no roteamento o braço iria trabalhar
    // no palete errado.
    const { noLado2, boxIndex: bi } = this.roteamento(p);
    const boxIndex = Math.min(TOTAL - 1, bi);
    const sl = slot(noLado2 ? -1 : 1, boxIndex % PER_PALLET);
    const j = this.ptp.j;

    return {
      j: [...j] as [number, number, number],
      phase: route(boxIndex)[this.wp]?.phase ?? 0,
      phaseName: p.celula.emergencia ? "EMERGÊNCIA"
        : p.robo.falha ? "ROBÔ EM FALHA"
        : !p.celula.automatico ? "MANUAL"
        : PHASES[route(boxIndex)[this.wp]?.phase ?? 0],
      carrying: this.carregando,
      // Enquanto o gêmeo carrega, a caixa da balança NÃO é desenhada.
      //
      // Na célula real a próxima caixa chega à balança enquanto o robô ainda
      // transporta a anterior — é verdade, mas a animação do gêmeo fica um
      // pouco atrás, e o resultado na tela era ver a MESMA caixa em dois
      // lugares: na garra e na balança. Confunde mais do que informa.
      // A caixa reaparece na balança quando o braço solta a que está levando.
      feed: this.feedX === null
        ? null
        : {
            x: this.feedX,
            // Ainda deslizando na esteira, ou já nos roletes com o veredito
            // da Toledo: 0 aguardando · 1 OK · 2 NOK.
            status: this.feedX > PICK.r + 1 ? "CHEGANDO"
                  : p.balanca.peso === 2 ? "REPROVADA"
                  : p.balanca.peso === 1 ? "PRONTA"
                  : "PESANDO",
          },
      // A balança publica veredito (OK/NOK), não o valor em kg — o peso em
      // número exigiria mais uma holding do lado dela.
      peso: p.balanca.peso === 1 ? 1 : 0,
      running: p.robo.run && !p.robo.falha,
      ritmo: 100,
      turbo: 1,
      paleteA: p.celula.palete1,
      paleteB: p.celula.palete2,
      saidaA: this.pal.A.saida,
      saidaB: this.pal.B.saida,
      emergencia: p.celula.emergencia,
      paletesProduzidos: p.paletesProduzidos ?? 0,
      status: {
        remoto: p.robo.remoto,
        servoOn: p.robo.servoOn,
        emCiclo: p.robo.masterJob,
        emHome: p.robo.home,
        falha: p.robo.falha,
        almRobo: p.almRobo,
        automatico: p.celula.automatico,
        portas: p.celula.porta1 && p.celula.porta2,
        barreiras: p.celula.barreira1 && p.celula.barreira2,
        descargaCheia: p.robo.descargaCheia,
        vacuoLigado: p.robo.vacuoLigado,
        vacuoOk: p.robo.vacuoOk,
        pressaoBar: p.pressaoBar,
        ladoAtivo: p.robo.lado1 ? 1 : p.robo.lado2 ? 2 : 0,
        almBalanca: p.almBalanca,
        seladoraDesabilitada: p.celula.seladoraDesabilitada,
      },
      fonte: "real",
      realOk: ok,
      tcp: fkTcp(j),
      speed: ok ? this.tcpSpeed : 0,
      placed: this.pilha(countA, countB),
      boxIndex,
      boxTotal: TOTAL,
      descartadas: 0,
      carryRot: sl.rot,
      countA,
      countB,
    };
  }

  stop() { clearInterval(this.timer); }
}
