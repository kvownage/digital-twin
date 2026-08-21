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
import { fkTcp, route, slot, PER_PALLET, TOTAL, PICK, PHASES } from "./simulator.js";
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
  private tCarregando = 0;          // s carregando — rede de segurança
  private depositoContado = false;  // o CLP já contou a caixa que está no ar?
  private ladoVoo: "A" | "B" | null = null;   // para qual palete ela vai
  private wpAlvo = -1;              // para qual trecho o goTo já foi emitido

  /** Teto de tempo carregando, antes de soltar por conta própria. */
  private static readonly MAX_CARREGANDO_S = 10;

  /** Larga a caixa e recua. Um só lugar, para não esquecer campo nenhum. */
  private solta() {
    this.carregando = false;
    this.ladoVoo = null;
    this.wp = 6;                    // RECUA
  }
  // ---- a caixa vindo pela esteira ----
  private feedX: number | null = null;   // posição no eixo da linha, ou null
  // ---- os paletes indo embora na empilhadeira ----
  private pal = {
    A: { pres: null as boolean | null, saida: 1, caixas: 0, qtdAnt: 0 },
    B: { pres: null as boolean | null, saida: 1, caixas: 0, qtdAnt: 0 },
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
   *  Diferente do roteamento, e o motivo é físico: o contador do CLP fala só
   *  do lado ATIVO. O outro lado pode ter um palete fechado esperando a
   *  empilhadeira, um palete interrompido no meio, ou um vazio recém-posto —
   *  e o contador não distingue nenhum dos três. Quem distingue é a memória
   *  de `pal.caixas`, que segue o contador enquanto o lado é atendido e
   *  congela quando deixa de ser. */
  private contagens(p: RealPayload) {
    const { noLado2 } = this.roteamento(p);
    // `caixas` segue o contador do CLP enquanto o lado é o ativo, e congela
    // quando deixa de ser (ver moveDoPalete).
    //
    // Menos a que está no ar. Quando o CLP conta o depósito antes de o braço
    // chegar ao slot, essa caixa está NA VENTOSA — desenhá-la também na pilha
    // mostraria a mesma caixa em dois lugares. Ela entra na pilha no instante
    // em que o braço a assenta, que é o que os olhos esperam ver.
    const noAr = this.carregando && this.depositoContado ? this.ladoVoo : null;
    const desc = (l: "A" | "B") => Math.max(0, this.pal[l].caixas - (noAr === l ? 1 : 0));
    return { noLado2, countA: desc("A"), countB: desc("B") };
  }

  /** Qual lado o robô está atendendo AGORA. Os dois falsos é resposta válida:
   *  significa "nenhum", e não deve ser confundido com "o lado 1". */
  private static ativos(p: RealPayload) {
    return {
      a: p.robo.lado1 && !p.robo.lado2,
      b: p.robo.lado2 && !p.robo.lado1,
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
    // (robô em home, em falha, fora do automático) nenhum lado é ativo, e o
    // contador não é de ninguém. Tratar "nenhum" como "lado 1" era o que
    // fazia a tela abrir com o palete A cheio, célula desligada.
    const rota = this.roteamento(p);
    const at = MqttSource.ativos(p);
    this.moveDoPalete("A", p.celula.palete1, at.a, rota.qtd, dt);
    this.moveDoPalete("B", p.celula.palete2, at.b, rota.qtd, dt);

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
    //  SINAIS MORTOS, medidos no tópico de produção (45 s, 106 mensagens):
    //
    //    "VC1 - VACUO OK GARRA" ............. sempre false
    //    "ROBO - CAIXA EM INDEXADOR" ........ sempre false
    //    "SFC2 - INDEXADOR CAIXA AVANCADO" .. sempre false
    //
    //  Nenhum dos três pode dirigir nada. Os dois de index são a razão de a
    //  lógica não pender neles, apesar de serem o nome natural para "há caixa
    //  esperando" — quem responde por isso é a balança.
    //
    //  UM SINAL MANDA NA CAIXA DA ENTRADA: `pecaEmPosicao`.
    //
    //    está ligado -> há caixa nos roletes, esperando o robô
    //    CAI         -> o robô a retirou: sobe e parte para o palete
    //    o contador INCREMENTA -> depositou: recua
    //
    //  Antes o vácuo também disparava a pega, e isso custou um defeito: o
    //  vácuo liga primeiro e a caixa só deixa de tapar o sensor ~0,6 s depois,
    //  então eram DUAS bordas para um único apanhar, e a segunda fazia o braço
    //  recuar no meio do caminho. Um sinal só não tem esse problema.
    // =======================================================================
    const naBalanca = p.balanca.pecaEmPosicao;
    const qtd = p.qtdeLado1;

    // primeira mensagem: só sincroniza, sem inventar evento
    if (this.qtdPrev < 0) {
      this.qtdPrev = qtd;
      this.naBalancaPrev = naBalanca;
    }

    // A caixa saiu dos roletes: foi o robô que a levou.
    const pegouAgora = this.naBalancaPrev && !naBalanca;

    // QUALQUER mudança do contador conta como depósito — sem exigir que o
    // valor novo seja maior. Pedir `qtd > 0` perdia exatamente o evento da
    // TROCA DE LADO, quando o contador vai de 32 para 0. De quebra, cobre o
    // recuo de falha (18 -> 16), que também é evento.
    const mudouContador = qtd !== this.qtdPrev;

    if (pegouAgora && !this.carregando) {
      this.carregando = true;
      this.tCarregando = 0;
      this.depositoContado = false;
      // Para qual palete esta caixa vai. Fixado AGORA, na pega: se fosse
      // consultado depois, a troca de lado no meio do voo mudaria a resposta.
      this.ladoVoo = rota.noLado2 ? "B" : "A";
      this.wp = 2;                    // SOBE, com a caixa
    } else if (pegouAgora) {
      // OUTRA caixa saiu dos roletes e o gêmeo ainda carrega a anterior.
      //
      // A célula não pegaria uma caixa nova se a anterior não tivesse sido
      // assentada — então este evento é, por si só, prova de que o depósito
      // aconteceu, mesmo que o contador não tenha dito nada.
      //
      // A versão anterior fazia o contrário: reiniciava o cão de guarda. Com
      // a célula produzindo, cada caixa nova renovava a espera e o braço
      // ficava plantado no slot INDEFINIDAMENTE, aguardando um contador que
      // não vinha para aquela posição. Era esse o travamento.
      //
      // Não se refaz `wp` aqui: refazer era o que fazia o braço recuar no
      // meio do caminho. Ele termina a viagem e solta ao chegar.
      this.depositoContado = true;
    }

    // =======================================================================
    //  O DEPÓSITO AUTORIZA SOLTAR — NÃO SOLTA
    //
    //  Antes, a mudança do contador encerrava o transporte na hora. Isso cria
    //  uma corrida: se a pega e o depósito caem no MESMO quadro, o transporte
    //  era iniciado e cancelado no mesmo instante, e a caixa aparecia no
    //  palete sem o braço levá-la. E não é hipótese remota — o contador do
    //  CLP não é obrigado a incrementar só no assentamento, e o gateway
    //  publica em lotes de até 100 ms.
    //
    //  Agora o contador só marca que o CLP já contou. Quem solta é a chegada
    //  do braço ao slot, mais abaixo. O trajeto sempre acontece por inteiro.
    // =======================================================================
    if (this.carregando) {
      this.tCarregando += dt;
      if (mudouContador) this.depositoContado = true;
    }
    // =======================================================================
    //  A CAIXA DA ENTRADA E O QUE A BALANCA DIZ - E NADA MAIS
    //
    //  Havia aqui uma animacao de chegada: o sensor SP3 disparava a viagem e
    //  a caixa deslizava da boca da esteira ate os roletes. Foi removida a
    //  pedido, e o motivo tecnico concorda com o pedido: era uma PREVISAO.
    //  O SP3 diz que algo passou pela entrada; quem sabe se ha caixa NOS
    //  ROLETES e a balanca. A previsao precisava de prazo de validade para
    //  nao deixar caixa fantasma parada, e a caixa nova nascia na posicao da
    //  anterior antes de subir a esteira de re - o teletransporte.
    //
    //  Agora ha caixa na balanca exatamente quando o sensor diz que ha, na
    //  posicao dos roletes. Nada e interpolado, nada e previsto.
    // =======================================================================
    this.feedX = naBalanca && !this.carregando ? PICK.r : null;

    this.naBalancaPrev = naBalanca;
    this.qtdPrev = qtd;

    // =======================================================================
    //  `chegou` SÓ VALE SE FALAR DO TRECHO ATUAL
    //
    //  `Ptp.goTo` zera `chegou` quando o alvo muda, e o `goTo` acontece no FIM
    //  deste método. Então, no quadro em que `wp` acaba de mudar, `chegou`
    //  ainda é do trecho ANTERIOR — e decidir com ele é decidir com informação
    //  velha. Duas consequências, as duas visíveis na tela:
    //
    //    - no quadro da pega, `wp` virava 2 (SOBE) e o avanço logo abaixo já
    //      pulava para 3: a subida nunca acontecia;
    //    - ao passar de 4 para 5, a soltura era avaliada no MESMO quadro com o
    //      `chegou` do 4, então a caixa era largada na pose de APROXIMAÇÃO,
    //      sem o braço nunca descer ao slot. Era o posicionamento errado.
    //
    //  `wpAlvo` guarda para qual trecho o `goTo` já foi emitido. Sem esse
    //  alinhamento, nada avança e nada solta.
    // =======================================================================
    const alinhado = this.wpAlvo === this.wp;

    if (this.carregando) {
      if (this.wp < 2) {
        this.wp = 2;                    // SOBE, com a caixa
      } else if (alinhado && this.ptp.chegou) {
        if (this.wp < 5) {
          this.wp++;                    // SOBE -> GIRO -> APROX -> DEPOSITA
        } else if (this.depositoContado) {
          // SOLTA: o braço chegou ao slot E o CLP já contou. Em qualquer
          // ordem — se o contador vier primeiro, o braço termina a viagem; se
          // chegar primeiro, espera ali pela confirmação.
          this.solta();
        }
      }
      // Rede de segurança. O trajeto inteiro leva ~2,2 s; dez segundos
      // carregando significa que o evento de depósito se perdeu — sinal,
      // reconexão, ou uma posição em que o robô não atualiza o contador.
      // Solta em vez de deixar o braço plantado no slot.
      //
      // Eram 25 s, e o cão de guarda ainda era reiniciado a cada nova pega:
      // com a célula produzindo, ele nunca disparava.
      if (this.carregando && this.tCarregando > MqttSource.MAX_CARREGANDO_S) {
        this.solta();
      }
    } else if (this.wp === 6) {
      if (alinhado && this.ptp.chegou) this.wp = 0;   // terminou de recuar
    } else {
      // Livre: espera sobre a balança; desce quando a peça está liberada.
      const pronta = naBalanca && p.balanca.peso === 1;
      this.wp = pronta ? 1 : 0;
    }

    this.ptp.goTo(wps[this.wp].j);
    this.wpAlvo = this.wp;
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
  //  paletes, e ele não fala do lado inativo. Se o operador tira o palete
  //  fechado e põe um vazio no lugar, o contador não muda nada — a tela
  //  redesenharia as caixas antigas sobre um palete que acabou de chegar
  //  vazio. Por isso `caixas` daquele lado zera quando a saída se completa.
  // --------------------------------------------------------------------------
  // 5 s para atravessar ~5,2 m: cerca de 1 m/s de média, que é passo de
  // empilhadeira carregada. Os 2,2 s de antes davam quase 2,4 m/s — parecia
  // fuga, não manobra.
  private static readonly SAIDA_S = 5.0;

  private moveDoPalete(
    lado: "A" | "B", presente: boolean, ativo: boolean, qtd: number, dt: number,
  ) {
    const e = this.pal[lado];

    // Primeira mensagem: só sincroniza. Sem palete no sensor não se inventa
    // uma saída que ninguém viu acontecer.
    if (e.pres === null) {
      e.pres = presente;
      e.saida = presente ? 0 : 1;
      // Começa VAZIO, sem adivinhar nada.
      //
      // A primeira versão assumia: palete presente num lado que o robô não
      // atende = palete que ele acabou de fechar, logo 32 caixas. Parecia
      // razoável — a célula alterna 1 e 2 — mas com o robô parado NENHUM lado
      // é o ativo, e a tela abria com o lado 1 cheio de caixas que não
      // existiam. Mostrar menos do que há é falta de informação; mostrar
      // caixas inventadas é mentira, e num supervisório mentira é pior.
      //
      // A pilha só aparece pelo que o gêmeo VIU acontecer. Quem abre a tela no
      // meio de um turno vê o palete do outro lado vazio até a próxima troca.
      e.caixas = 0;
      e.qtdAnt = qtd;
    }

    if (e.pres && !presente) {            // borda de queda: a empilhadeira entrou
      e.saida = 0;
      // `caixas` NÃO zera aqui: a carga está saindo EM CIMA do palete e
      // precisa continuar desenhada durante o trajeto. Zerar na borda fazia
      // o palete atravessar a cena vazio e as caixas evaporarem no lugar.
    }
    if (!e.pres && presente) e.saida = 0; // palete novo no lugar
    e.pres = presente;

    if (!presente && e.saida < 1) {
      e.saida = Math.min(1, e.saida + dt / MqttSource.SAIDA_S);
      // Saiu de cena: agora sim a carga deixou de existir aqui. Um palete
      // novo entra vazio, mesmo com o contador do CLP marcando 32.
      if (e.saida >= 1) e.caixas = 0;
    }
    if (presente) e.saida = 0;

    // =====================================================================
    //  QUANTAS CAIXAS ESTÃO NESTE PALETE
    //
    //  Enquanto este é o lado ativo, o contador do CLP é dele e a resposta é
    //  direta. Quando deixa de ser, o valor CONGELA — e é isso que mantém o
    //  palete fechado na tela, esperando a empilhadeira.
    //
    //  A versão anterior guardava um booleano "cheio", ligado sempre que o
    //  lado deixava de ser ativo depois de ter recebido caixas. Errado: robô
    //  indo para home, entrando em falha ou saindo do automático também deixa
    //  de atender o lado — e a tela pintava 32 caixas onde havia 4. Guardar o
    //  NÚMERO acerta nos dois casos, e de graça mostra o palete interrompido
    //  no meio com a quantidade que ele realmente tem.
    // =====================================================================
    if (ativo) {
      // A troca de lado zera o contador. Se ela chegar no mesmo quadro em que
      // este lado ainda está marcado como ativo, o zero apagaria o palete que
      // acabou de ser fechado — então esse quadro é ignorado. Recuo de falha
      // (18 -> 16) não é zero, e continua sendo respeitado.
      const zerou = qtd === 0 && e.qtdAnt > 0;
      if (!zerou) e.caixas = qtd;
      e.qtdAnt = qtd;
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
            x: this.feedX,                 // sempre os roletes: não há viagem
            // O veredito da Toledo: 0 aguardando · 1 OK · 2 NOK.
            status: p.balanca.peso === 2 ? "REPROVADA"
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
