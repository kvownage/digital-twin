import { useEffect, useState } from "react";
import { Cell } from "./scene/Cell";
import { Panel } from "./ui/Panel";
import { useRobot } from "./lib/useRobot";

/** Data e hora do turno, batendo de segundo em segundo.
 *
 *  Relógio próprio, e não derivado do estado que chega da célula: se a fonte
 *  parar, o relógio continua andando e é o SELO ao lado que denuncia a parada.
 *  Um relógio que congela junto pareceria tela travada, e travada ela não
 *  está — o dado é que sumiu. */
function Relogio() {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="relogio">
      {agora.toLocaleDateString("pt-BR")}
      <b>{agora.toLocaleTimeString("pt-BR")}</b>
    </span>
  );
}

export function App() {
  const robot = useRobot();

  return (
    <div className="wrap">
      <header>
        <h1>Supervisório · Célula R-01</h1>
        <span className="tag">MOTOMAN GP12 · PALETIZAÇÃO · mm</span>
        <span className="spacer" />
        <Relogio />
        {!robot.connected ? (
          <span className="pill off">SEM COMUNICAÇÃO</span>
        ) : robot.state?.fonte === "real" ? (
          robot.state.realOk
            ? <span className="pill ok">TEMPO REAL</span>
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

      {/* Sem rodapé explicativo: era nota de desenvolvimento, não informação
          de operação. Quem abre esta tela quer ver a célula, não ler sobre
          ela — o "como funciona" mora no README e nos comentários do código. */}
    </div>
  );
}
