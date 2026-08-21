import { Cell } from "./scene/Cell";
import { Panel } from "./ui/Panel";
import { useRobot } from "./lib/useRobot";

export function App() {
  const robot = useRobot();

  return (
    <div className="wrap">
      <header>
        <h1>Supervisório · Célula R-01</h1>
        <span className="tag">MOTOMAN GP12 · PALETIZAÇÃO · mm</span>
        <span className="spacer" />
        {!robot.connected ? (
          <span className="pill off">SEM COMUNICAÇÃO</span>
        ) : robot.state?.fonte === "real" ? (
          robot.state.realOk
            ? <span className="pill ok">DADOS REAIS</span>
            : <span className="pill off">SEM DADOS REAIS</span>
        ) : (
          <span className="pill sim">DADOS SIMULADOS</span>
        )}
      </header>

      <div className="grid">
        <section className="card stage">
          <div className="canvas-box">
            <Cell
              live={robot.liveRef}
              layout={robot.layout}
              placed={robot.state?.placed ?? []}
            />
          </div>
          <span className="dica">ARRASTE PARA ORBITAR · RODA PARA APROXIMAR</span>
        </section>

        <Panel robot={robot} />
      </div>

      <footer>
        Paletização de ventiladores de mesa 40 cm em CATAVENTO, a sequência
        desenhada pelo operador: 4 fileiras de 4 lombadas por camada
        (1→2→3→4), camada de cima girada 90° — <b>32 por palete</b>, e o robô
        monta um palete inteiro antes de começar o outro. O GP12 fica num
        <code> pedestal de 800 mm</code>: o slot mais distante do catavento
        exige ~1410 mm de raio, fora do alcance no chão. Cada posição vira
        ângulos de junta por <code>cinemática inversa</code> no
        <code> servidor Node</code>; PTP sincronizado com as velocidades reais
        de junta. Para o robô real, trocar <code>Gp12Simulator</code> por
        <code> YaskawaHses</code>.
      </footer>
    </div>
  );
}
