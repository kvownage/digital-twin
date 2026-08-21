// ============================================================================
//  O GP12 como hierarquia de juntas em react-three-fiber.
//
//  A cadeia:  <group S>  gira no eixo vertical (base)
//               <group L>  no ombro (450/155), braço inferior ao longo de +Y
//                 <group U>  no cotovelo, antebraço ao longo de +X
//                   <group punho>  compensa o U e mantém a ferramenta vertical
//
//  O corpo visual segue a FOTO e o desenho cotado do robô real:
//   - corpo do S inclinado à frente (o offset de 155 até o ombro)
//   - conduíte corrugado preto subindo pelas costas, em três trechos rígidos,
//     cada um preso ao elo que acompanha
//   - cotovelo com o tampão duplo (motor U + motor R atrás)
//   - antebraço CÔNICO, afinando para o punho, com YASKAWA nas laterais
//   - tampas de motor escuras, plaquetas vermelhas, flange com parafusos
//
//  Os ângulos NÃO passam por estado React: a cena lê o último quadro de rede
//  num ref e interpola a 60 fps no useFrame — rede a 25 Hz, tela a 60.
// ============================================================================
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { CaixaVentilador } from "./CaixaVentilador";
import type { RobotState } from "../../../shared/types";

const rad = (d: number) => (d * Math.PI) / 180;

// Dimensões do desenho cotado (mm) — as mesmas do servidor
const S_OFF = 155, L_H = 450, L1 = 614, RISER = 200, L2 = 640, TOOL = 130;
// Caixa de ventilador de mesa 40 cm, EM PÉ (lombada de 150)
const BOX_W = 500, BOX_D = 150, BOX_H = 570;

const AZUL = "#2E55C6";
const AZUL_FUNDO = "#24449F";     // faces menos iluminadas do casting
const ESCURO = "#1B2F73";
const TAMPA = "#141E3F";          // tampas de motor
const CABO = "#0B0E12";           // conduíte corrugado
const RUBRO = "#B3282D";

// ----------------------------------------------------------------------------
//  Peças de composição
// ----------------------------------------------------------------------------

function Corpo({ cor = AZUL, ...props }: React.ComponentProps<typeof RoundedBox> & { cor?: string }) {
  return (
    <RoundedBox radius={9} smoothness={3} castShadow receiveShadow {...props}>
      <meshStandardMaterial color={cor} roughness={0.4} metalness={0.18} />
    </RoundedBox>
  );
}

/** Cilindro de motor com tampa escura nas pontas — a assinatura dos eixos. */
function Motor(props: {
  position?: [number, number, number];
  rotation?: [number, number, number];
  r: number;
  h: number;
  cor?: string;
}) {
  const { r, h, cor = AZUL } = props;
  return (
    <group position={props.position} rotation={props.rotation}>
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[r, r, h, 36]} />
        <meshStandardMaterial color={cor} roughness={0.35} metalness={0.28} />
      </mesh>
      {[1, -1].map((s) => (
        <mesh key={s} position={[0, (h / 2 + 9) * s, 0]} castShadow>
          <cylinderGeometry args={[r * 0.78, r * 0.78, 20, 32]} />
          <meshStandardMaterial color={TAMPA} roughness={0.5} metalness={0.35} />
        </mesh>
      ))}
    </group>
  );
}

/** Trecho rígido do conduíte corrugado, preso ao elo que o carrega. */
function Cabo({ pontos, r = 24 }: { pontos: [number, number, number][]; r?: number }) {
  const geo = useMemo(() => {
    const curva = new THREE.CatmullRomCurve3(pontos.map((p) => new THREE.Vector3(...p)));
    return new THREE.TubeGeometry(curva, 28, r, 10, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <mesh geometry={geo} castShadow>
      <meshStandardMaterial color={CABO} roughness={0.92} />
    </mesh>
  );
}

// Rótulos pintados no casting — textura de canvas, uma por texto.
const rotulos: Record<string, THREE.CanvasTexture> = {};
function rotuloTex(texto: string): THREE.CanvasTexture {
  if (rotulos[texto]) return rotulos[texto];
  const cv = document.createElement("canvas");
  cv.width = 512; cv.height = 112;
  const g = cv.getContext("2d")!;
  g.clearRect(0, 0, 512, 112);
  g.fillStyle = "#FFFFFF";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "700 84px 'IBM Plex Sans', sans-serif";
  g.fillText(texto, 256, 60);
  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = 4;
  rotulos[texto] = t;
  return t;
}

function Rotulo({ texto, w, h, position, rotation }: {
  texto: string; w: number; h: number;
  position: [number, number, number];
  rotation?: [number, number, number];
}) {
  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial map={rotuloTex(texto)} transparent roughness={0.6} />
    </mesh>
  );
}

/** Base reta com ventosas + a FLANGE do eixo T com o círculo de parafusos. */
function Ventosas() {
  const posicoes: [number, number][] = [[-150, 0], [0, 0], [150, 0]];
  return (
    <group>
      {/* flange do T: o disco CLARO usinado com o círculo de parafusos */}
      <mesh position={[0, -12, 0]} castShadow>
        <cylinderGeometry args={[58, 58, 18, 28]} />
        <meshStandardMaterial color="#C9D2DA" roughness={0.3} metalness={0.55} />
      </mesh>
      {Array.from({ length: 6 }).map((_, i) => {
        const a = (i / 6) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * 42, -20, Math.sin(a) * 42]}>
            <cylinderGeometry args={[5, 5, 10, 8]} />
            <meshStandardMaterial color="#0E1524" roughness={0.6} />
          </mesh>
        );
      })}
      {/* haste do punho à placa */}
      <mesh position={[0, -55, 0]} castShadow>
        <boxGeometry args={[46, 70, 46]} />
        <meshStandardMaterial color={ESCURO} roughness={0.45} metalness={0.3} />
      </mesh>
      {/* a placa */}
      <mesh position={[0, -98, 0]} castShadow>
        <boxGeometry args={[430, 22, 130]} />
        <meshStandardMaterial color={ESCURO} roughness={0.4} metalness={0.35} />
      </mesh>
      {/* os foles */}
      {posicoes.map(([x, z], i) => (
        <mesh key={i} position={[x, -119, z]} castShadow>
          <cylinderGeometry args={[30, 40, 22, 20]} />
          <meshStandardMaterial color="#20262D" roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

// ----------------------------------------------------------------------------
//  O robô
// ----------------------------------------------------------------------------
/** O braço inferior CURVO do GP12: seção retangular arredondada extrudada ao
 *  longo de uma curva que faz barriga PARA TRÁS — o casting real não é reto. */
function geoBracoCurvo(): THREE.ExtrudeGeometry {
  const curva = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 55, 0),
    new THREE.Vector3(-80, L1 * 0.5, 0),
    new THREE.Vector3(0, L1 - 45, 0),
  ]);
  const w = 56, h = 70, r = 18;      // meia-largura, meia-profundidade, canto
  const forma = new THREE.Shape();
  forma.moveTo(-w + r, -h);
  forma.lineTo(w - r, -h); forma.absarc(w - r, -h + r, r, -Math.PI / 2, 0, false);
  forma.lineTo(w, h - r);  forma.absarc(w - r, h - r, r, 0, Math.PI / 2, false);
  forma.lineTo(-w + r, h); forma.absarc(-w + r, h - r, r, Math.PI / 2, Math.PI, false);
  forma.lineTo(-w, -h + r); forma.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
  return new THREE.ExtrudeGeometry(forma, {
    steps: 36, bevelEnabled: false, extrudePath: curva,
  });
}

export function Robot({ live }: { live: React.MutableRefObject<RobotState | null> }) {
  const bracoGeo = useMemo(geoBracoCurvo, []);
  const sRef = useRef<THREE.Group>(null!);
  const lRef = useRef<THREE.Group>(null!);
  const uRef = useRef<THREE.Group>(null!);
  const wRef = useRef<THREE.Group>(null!);
  const tRef = useRef<THREE.Group>(null!);      // eixo T: gira FERRAMENTA + caixa
  const caixaGarra = useRef<THREE.Group>(null!);

  // ângulos exibidos, perseguindo os de rede com amortecimento
  const cur = useRef<[number, number, number]>([0, -5, -50]);
  const yaw = useRef(0);   // eixo T emulado: esquadra a caixa com o palete

  useFrame((_s, dt) => {
    const st = live.current;
    if (!st) return;
    // EMERGÊNCIA: o braço congela ONDE ESTAVA. Nem termina o movimento, nem
    // volta para casa — é o que a categoria de segurança faz na célula real.
    if (st.emergencia) return;
    const k = Math.min(1, dt * 14);
    for (let i = 0; i < 3; i++) cur.current[i] += (st.j[i] - cur.current[i]) * k;
    const [S, L, U] = cur.current;

    sRef.current.rotation.y = rad(S);
    lRef.current.rotation.z = -rad(L);
    uRef.current.rotation.z = rad(L) - rad(U);   // local: absoluto do antebraço = U
    wRef.current.rotation.z = rad(U);            // devolve a ferramenta à vertical

    // O T (giro da ferramenta) não está nas 3 juntas simuladas: emula-se aqui.
    // Gira o CONJUNTO ferramenta+caixa — a caixa nunca desliza na ventosa.
    const alvoYaw = st.carrying && st.phase >= 3 ? st.carryRot - S : 0;
    yaw.current += (alvoYaw - yaw.current) * k;
    tRef.current.rotation.y = rad(yaw.current);

    caixaGarra.current.visible = st.carrying;
  });

  return (
    <group ref={sRef}>
      {/* ------------------------------------------------------ eixo S ----- */}
      {/* carrossel: leve cone, como o casting da mesa giratória */}
      <mesh position={[0, 212, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[138, 156, 66, 40]} />
        <meshStandardMaterial color={AZUL} roughness={0.4} metalness={0.18} />
      </mesh>

      {/* corpo do S inclinado à frente — é ele que leva o ombro aos 155 mm */}
      <Corpo args={[235, 300, 232]} position={[48, 330, 0]} rotation={[0, 0, -0.32]} />
      <Corpo args={[150, 130, 200]} position={[130, 425, 0]} cor={AZUL_FUNDO} />

      {/* etiqueta de advertência no peito do S */}
      <mesh position={[10, 330, 119]} rotation={[0, 0, -0.32]}>
        <planeGeometry args={[86, 46]} />
        <meshStandardMaterial color="#E8C24A" roughness={0.6} />
      </mesh>

      {/* o SERVO do eixo S: PRETO, deitado, saindo em diagonal no nível do
          carrossel — como no modelo real */}
      <group rotation={[0, -0.55, 0]}>
        <Motor position={[-155, 262, 0]} rotation={[0, 0, Math.PI / 2]} r={56} h={168} cor="#191D24" />
      </group>

      {/* ombro LISO: só as bossas do casting, sem motor exposto */}
      {[1, -1].map((s) => (
        <mesh key={s} position={[S_OFF, L_H, 86 * s]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[96, 103, 62, 36]} />
          <meshStandardMaterial color={AZUL} roughness={0.4} metalness={0.18} />
        </mesh>
      ))}
      {[1, -1].map((s) => (
        <mesh key={s} position={[S_OFF, L_H, 122 * s]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[44, 44, 14, 24]} />
          <meshStandardMaterial color={TAMPA} roughness={0.5} metalness={0.35} />
        </mesh>
      ))}

      {/* conduíte: da base ao alto do corpo S */}
      <Cabo pontos={[[-95, 200, -60], [-160, 310, -50], [-95, 425, -10]]} />

      <group position={[S_OFF, L_H, 0]} ref={lRef}>
        {/* --------------------------------------------------- braço L ----- */}
        {/* o braço CURVO (barriga para trás) entre as bossas de junta */}
        <Corpo args={[150, 160, 158]} position={[0, 45, 0]} cor={AZUL_FUNDO} />
        <mesh geometry={bracoGeo} castShadow receiveShadow>
          <meshStandardMaterial color={AZUL} roughness={0.4} metalness={0.18} />
        </mesh>
        <Corpo args={[146, 160, 152]} position={[0, L1 - 35, 0]} cor={AZUL_FUNDO} />

        {/* plaquetas vermelhas dos DOIS lados, acompanhando a barriga */}
        {[1, -1].map((s) => (
          <mesh key={s} position={[-62, 390, 74 * s]} rotation={[0, 0, 0.12]}>
            <boxGeometry args={[58, 120, 10]} />
            <meshStandardMaterial color={RUBRO} roughness={0.5} />
          </mesh>
        ))}
        {/* conduíte subindo pelas costas do braço, atrás da barriga */}
        <Cabo pontos={[[-95, 60, 55], [-170, 300, 58], [-90, 560, 50]]} />

        <group position={[0, L1, 0]} ref={uRef}>
          {/* ------------------------------------------------- cotovelo ---- */}
          {/* hub do casting + o SERVO PRETO lateral, como no modelo real */}
          <Motor rotation={[Math.PI / 2, 0, 0]} r={94} h={190} />
          <Corpo args={[132, RISER + 30, 150]} position={[0, RISER / 2, 0]} />
          <Motor position={[-40, 60, 148]} rotation={[Math.PI / 2, 0.4, 0]} r={58} h={135} cor="#191D24" />

          {/* antebraço QUADRADO com o VÃO no meio — o braço oco do GP12:
              bloco cheio no cotovelo, duas bochechas paralelas com a janela
              entre elas, e o bloco de convergência no punho */}
          <Corpo args={[270, 158, 152]} position={[85, RISER, 0]} />
          {[1, -1].map((s) => (
            <Corpo key={s} args={[340, 132, 46]} position={[340, RISER, 60 * s]} />
          ))}
          <Corpo args={[160, 116, 126]} position={[565, RISER, 0]} cor={AZUL_FUNDO} />

          {/* YASKAWA nas bochechas do vão */}
          <Rotulo texto="YASKAWA" w={280} h={56}
                  position={[340, RISER, 84]} />
          <Rotulo texto="YASKAWA" w={280} h={56}
                  position={[340, RISER, -84]} rotation={[0, Math.PI, 0]} />

          {/* conduíte mergulhando no braço oco */}
          <Cabo pontos={[[-150, 130, 55], [-60, 250, 68], [110, 262, 40]]} r={20} />

          <group position={[L2, RISER, 0]} ref={wRef}>
            {/* --------------------------------------------------- punho --- */}
            <Motor rotation={[Math.PI / 2, 0, 0]} r={50} h={158} />
            <Corpo args={[86, 70, 96]} position={[0, -28, 0]} cor={AZUL_FUNDO} />
            {/* do flange do T para baixo, TUDO gira junto */}
            <group ref={tRef}>
              <Ventosas />
              {/* a caixa em pé, presa pela borda superior: topo no TCP */}
              <group ref={caixaGarra} position={[0, -TOOL - BOX_H / 2, 0]}>
                <CaixaVentilador w={BOX_W} h={BOX_H} d={BOX_D} />
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}
