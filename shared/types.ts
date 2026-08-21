// ============================================================================
//  Contrato entre servidor e navegador — o ÚNICO lugar que define as mensagens.
// ============================================================================

export interface Vec3 { x: number; y: number; z: number }

/** Caixa depositada: posição do centro + orientação (giro em torno do vertical). */
export interface PlacedBox extends Vec3 { rot: number }

/** Estado do robô num instante. As juntas em graus: [S, L, U]. */
export interface RobotState {
  j: [number, number, number];
  /** Índice em phases; -1 = troca de paletes. */
  phase: number;
  phaseName: string;
  carrying: boolean;
  /** A caixa na entrada: posição no eixo da linha e o estágio dela.
   *  null = nenhuma caixa na entrada (está na garra, ou troca de paletes). */
  feed: {
    x: number;
    status: "SELANDO" | "CHEGANDO" | "PESANDO" | "PRONTA" | "REPROVADA";
  } | null;
  /** Leitura atual da balança Toledo (kg). Mantém a última pesagem. */
  peso: number;
  running: boolean;
  ritmo: number;
  /** Multiplicador de tempo da simulação (dev). 1 = tempo real. */
  turbo: number;
  /** Presença de palete nos dois lados (SP4/SP5). Sem palete, a cena não
   *  desenha nem o palete nem a pilha — nada de pilha fantasma. */
  paleteA: boolean;
  paleteB: boolean;
  /** Célula em emergência: o braço congela onde estava. */
  emergencia: boolean;
  /** Paletes completos produzidos (contador do CLP). */
  paletesProduzidos: number;

  /** Status para a tela. Cada campo aqui existe para responder a UMA
   *  pergunta do operador ou da manutenção — nada de despejar sinal cru. */
  status: {
    // ---- o robô está em condição de produzir? ----
    remoto: boolean;        // REMOTO = o CLP comanda; LOCAL = alguém no pendant
    servoOn: boolean;
    emCiclo: boolean;       // master job rodando
    emHome: boolean;
    falha: boolean;
    almRobo: number;        // código do alarme: é o que a manutenção precisa

    // ---- se está parado, o que impede? ----
    automatico: boolean;    // modo da CÉLULA (diferente do remoto do robô)
    portas: boolean;        // as duas chaves de segurança fechadas
    barreiras: boolean;     // as duas barreiras livres
    descargaCheia: boolean; // palete cheio esperando empilhadeira

    // ---- a ferramenta e o ar: a causa nº 1 de parada em célula de ventosa ----
    vacuoLigado: boolean;
    vacuoOk: boolean;       // ligado SEM ok = caixa caiu ou vazamento
    pressaoBar: number;

    // ---- a linha em volta ----
    ladoAtivo: 1 | 2 | 0;
    almBalanca: number;
    seladoraDesabilitada: boolean;
  };
  /** De onde os dados vêm agora. */
  fonte: "sim" | "real";
  /** Em modo real: o broker está entregando dados frescos? */
  realOk: boolean;
  tcp: Vec3;
  speed: number;
  /** Caixas já paletizadas (mundo, mm) — o cliente as desenha. */
  placed: PlacedBox[];
  boxIndex: number;
  boxTotal: number;
  /** Caixas reprovadas pela balança e descartadas pelo robô. */
  descartadas: number;
  /** Orientação (yaw, graus) em que a caixa da vez assenta no palete. */
  carryRot: number;
  countA: number;
  countB: number;
}

/** Primeira mensagem após conectar: o que o cliente precisa para se montar. */
export interface HelloMsg {
  type: "hello";
  phases: string[];
  layout: {
    pick: { r: number; top: number };
    pallet: { size: number; top: number; r: number };
    /** Caixa de ventilador de mesa, EM PÉ: w de largura, d de lombada, h de altura. */
    box: { w: number; d: number; h: number };
    /** Altura do pedestal do robô (mm) — necessário para alcançar a 2ª camada. */
    pedestal: number;
  };
}

export interface StateMsg extends RobotState {
  type: "state";
}

export type ServerMsg = HelloMsg | StateMsg;

/** Comandos da IHM para o servidor. O servidor valida tudo. */
export type ClientCmd =
  | { cmd: "run"; value: boolean }
  | { cmd: "ritmo"; value: number }
  /** Ferramentas de DESENVOLVIMENTO — não existem na célula real. */
  | { cmd: "preview" }             // monta os dois paletes instantaneamente
  | { cmd: "reset" }               // zera tudo e recomeça da caixa 1
  | { cmd: "turbo"; value: number } // acelera o TEMPO da simulação (1..20x)
  /** Troca da fonte de dados: célula real (MQTT) ou simulador. */
  | { cmd: "fonte"; value: "sim" | "real" };

/** O que o GATEWAY publica no broker — uma mensagem JSON por mudança.
 *
 *  Espelha o mapa Modbus REAL da célula (DB 37 "MODBUS HOLDINGS" do projeto
 *  CLP_VENTILADOR_EMBALAGEM). Ver docs/ARQUITETURA.md §1 e plc/07_SUPERVISORIO.scl.
 *  Os nomes são os do CLP, não os do simulador — quem for conferir com o
 *  eletricista lê a mesma coisa nos dois lados. */
export interface RealPayload {
  ts: number;              // epoch ms de quando o gateway leu
  plcOk: boolean;          // heartbeat do CLP (HR26) está andando?

  /** HR10 — estado do robô */
  robo: {
    run: boolean; servoOn: boolean; masterJob: boolean; falha: boolean;
    remoto: boolean; home: boolean; foraHome: boolean; pegaOk: boolean;
    lado1: boolean; lado2: boolean; caixaIndexador: boolean;
    vacuoLigado: boolean; vacuoOk: boolean; descargaCheia: boolean;
    fimEncaix1: boolean; fimEncaix2: boolean;
  };

  /** HR11 — célula e segurança */
  celula: {
    caixaNaEsteira: boolean; indexadorAvancado: boolean; pecaNoRobo: boolean;
    /** Presença de palete: SP4 e SP5 (os SP1/SP2 não são presença real). */
    palete1: boolean; palete2: boolean;
    esteiraEntrada: boolean; esteiraSaida: boolean; seladoraDesabilitada: boolean;
    automatico: boolean; porta1: boolean; porta2: boolean;
    barreira1: boolean; barreira2: boolean; torreVermelha: boolean;
    /** Emergência consolidada do DB COMANDOS, e a causa por botão. */
    emergencia: boolean; emergenciaBotao: boolean;
  };

  /** HR12..14 — passos das sequências (DB "ESTADOS") */
  passos: { inicializacao: number; lado1: number; lado2: number };

  /** HR15..22 — números do processo, vindos do robô */
  qtdeLado1: number;
  place: number;           // posição dentro da sequência do mosaico
  camadaRetorno: number;
  alturaCaixa: number;
  alturaPallet: number;
  shiftY: number;
  shiftZ: number;
  camadaComando: number;

  /** HR27 — paletes completos produzidos (contador do DB COMANDOS). */
  paletesProduzidos: number;

  /** HR23..25 */
  almRobo: number;
  almBalanca: number;
  pressaoBar: number;

  /** HR0..3 — a integração de balança que já existia */
  balanca: {
    pecaEmPosicao: boolean;
    peso: 0 | 1 | 2;       // 0 aguardando · 1 OK · 2 NOK
    lifeBit: boolean;
  };
}
