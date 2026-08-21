# Gateway da Célula R-01 — instalação no PC da fábrica

Lê o CLP por **Modbus TCP** e publica no **broker MQTT**. Roda na máquina que
enxerga a rede do CLP. Não precisa do React, do three.js nem do build do
cliente — é um pacote autônomo de ~25 MB.

**Ele só LÊ o CLP.** Nunca escreve. Se morrer, nada se perde: não guarda estado.

---

## O que copiar para o outro PC

Copie **duas pastas**, preservando a estrutura (o gateway importa o contrato
de `shared/`, que é a única fonte de verdade das mensagens):

```
<qualquer-pasta>/
├── gateway/          ← todos os arquivos desta pasta
└── shared/
    └── types.ts
```

Da pasta `gateway/` bastam: `index.ts`, `testa-modbus.ts`, `package.json`,
`.env.example` e este `LEIA-ME.md`. O `clp-falso.ts` é opcional (só serve
para testar sem o CLP).

**NÃO copie** `node_modules` — ele se instala no destino.

## Pré-requisito

**Node.js 20 ou mais novo** — https://nodejs.org (instalador LTS). Confirme
com `node --version`.

## Instalação (uma vez)

```powershell
cd <pasta>\gateway
npm install
npm approve-scripts esbuild     # o npm bloqueia scripts por padrão
npm rebuild esbuild
```

Se a rede da empresa bloquear o registro npm, instale numa máquina com
internet e copie a pasta `node_modules` junto — ela é portátil entre
Windows da mesma arquitetura.

## Configuração

```powershell
copy .env.example .env
notepad .env
```

Preencha:

```env
PLC_IP=192.168.x.x                # IP do S7 na rede
PLC_PORT=502
PLC_UNIT=1
MQTT_URL=mqtts://SEU-CLUSTER.s1.eu.hivemq.cloud:8883
MQTT_USER=celula-r01
MQTT_PASS=<a senha do broker>
MQTT_TOPICO=multilaser/paletizadora/r01/estado
```

> A credencial do broker vai **separada** da URL de propósito: senha com
> `@ : / #` não sobrevive dentro de uma URL.

## Testar antes de ligar

```powershell
npm run testa-modbus
```

Três degraus, e cada falha aponta a causa:

| Passo | Prova | Se falhar |
|---|---|---|
| 1 conecta na 502 | `MB_SERVER` escutando com instância livre | CLP em STOP, IP errado, ou a balança ocupou a única conexão |
| 2 lê HR0..HR27 | o mapa de holdings responde | (raro se o 1 passou) |
| 3 relê em 500 ms | **HR26 mudou** = o programa roda e a FC 07 é chamada | CLP em STOP com Modbus vivo, ou FC 07 fora do Main |

## Rodar

```powershell
npm start
```

Esperado no log:

```
[gateway] broker OK: mqtts://...
[gateway] CLP OK: 192.168.x.x:502
[gateway] lendo HR0..HR34, publicando em multilaser/paletizadora/r01/estado
```

## Deixar rodando sozinho (produção)

O gateway precisa estar de pé 24/7. Sem terminal aberto:

**Agendador de Tarefas do Windows** — a via simples:
1. Criar Tarefa Básica → *Ao iniciar o computador*
2. Ação: `cmd.exe`
3. Argumentos: `/c cd /d "<pasta>\gateway" && npm start >> gateway.log 2>&1`
4. Em *Condições*, desmarque "Iniciar somente se o computador estiver ligado
   na tomada"
5. Em *Configurações*, marque "Se a tarefa falhar, reiniciar a cada 1 minuto"

Para reinício automático em caso de falha do processo (mais robusto), use
[NSSM](https://nssm.cc) e registre `npm start` como serviço do Windows.

## Diagnóstico rápido

| Sintoma no log | Causa provável |
|---|---|
| `CLP indisponível ... ECONNREFUSED` | CLP em STOP, IP errado, ou firewall bloqueando a 502 |
| `CLP indisponível ... timeout` | a **única** conexão `MB_SERVER` está ocupada (a balança) — falta a 2ª instância no CLP |
| `broker: Connection refused: Not authorized` | `MQTT_USER`/`MQTT_PASS` vazios ou errados |
| `broker: Missing protocol` | falta o `mqtts://` no `MQTT_URL` |
| conecta, mas o supervisório mostra **SEM DADOS REAIS** | `HR26` congelado: CLP em STOP ou FC 07 não é chamada no Main |
