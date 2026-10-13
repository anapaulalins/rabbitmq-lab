# RabbitMQ Lab

Laboratório para entender, na prática e na AWS, o fluxo de eventos por RabbitMQ:

- uma **API** publica eventos de visitas (`company.<id>.visit.created`);
- cada **empresa** pode ter uma **fila própria** com um **usuário que só consome** essa fila;
- a **integração do cliente** conecta no Rabbit pela internet e consome a fila, **sem abrir porta nenhuma do lado dela**.

```
                    VPC (rede privada da AWS)
   ┌─────────────────────────────────────────────────────────┐
   │                                                         │
   │   EC2 "app"                         EC2 "rabbit"        │
   │  ┌──────────────┐   5672 (privado) ┌────────────────┐   │
   │  │ API + React  │ ───────────────▶ │   RabbitMQ     │   │
   │  │  porta 80    │   15672 (admin)  │                │   │
   │  └──────────────┘ ───────────────▶ └────────────────┘   │
   │         ▲                                  ▲            │
   └─────────┼──────────────────────────────────┼────────────┘
             │ HTTP (navegador)                 │ 5672 (etapa 1) ou
             │                                  │ 5671 TLS (etapa 2)
        você no navegador              consumer/ (simula o cliente,
                                       roda no seu notebook)
```

| Pasta | O que é | Onde roda |
|---|---|---|
| `rabbit/` | RabbitMQ em Docker | EC2 "rabbit" |
| `app/` | API Node (Express) + front React | EC2 "app" |
| `consumer/` | Script que simula a integração do cliente | Seu notebook |

### O que é igual e o que muda em relação à infra da empresa

| No lab | Na empresa | Muda algo no Rabbit? |
|---|---|---|
| 1 EC2 com a API | Beanstalk (N instâncias que sobem e caem) + ALB | **Não.** Cada instância abre a própria conexão AMQP com o Rabbit. O ALB só cuida do HTTP e não participa do AMQP. |
| SG do Rabbit libera 5672 para o SG "app" | SG do Rabbit libera 5672 para o SG do Beanstalk | Mesma ideia: liberar por **Security Group** e não por IP, porque as instâncias do Beanstalk mudam de IP. |
| JSON em arquivo | Postgres | Não. |

---

## Custos (leia antes)

- 2× `t3.micro`. Verifique se a sua conta ainda tem free tier, porque as regras mudaram para contas novas.
- **IPv4 público é cobrado** por hora (~US$ 0,005/h por IP), mesmo no free tier.
- **Pare ou termine as instâncias quando terminar.** Veja [Limpeza](#limpeza).

---

## Passo 1: Key pair e Security Groups

No console da AWS, escolha **uma região** (ex.: `us-east-1`) e use sempre ela.

1. **EC2 → Key pairs → Create key pair**: `rabbitmq-lab`, tipo `.pem`. Guarde o arquivo e rode `chmod 400 rabbitmq-lab.pem`.

2. **EC2 → Security Groups → Create**, na VPC default.

   **`sg-lab-app`** (API):

   | Tipo | Porta | Origem | Por quê |
   |---|---|---|---|
   | SSH | 22 | My IP | você acessar a máquina |
   | HTTP | 80 | My IP | você abrir a tela no navegador |

   **`sg-lab-rabbit`** (RabbitMQ):

   | Tipo | Porta | Origem | Por quê |
   |---|---|---|---|
   | SSH | 22 | My IP | você acessar a máquina |
   | Custom TCP | 5672 | **`sg-lab-app`** (selecione o SG, não um IP) | API publica pela rede privada |
   | Custom TCP | 15672 | **`sg-lab-app`** | API cria usuários e filas |
   | Custom TCP | 15672 | My IP | você ver o painel do Rabbit |
   | Custom TCP | 5672 | My IP | **etapa 1**: o consumer no seu notebook (sem TLS, só para o lab) |

   > "My IP" é o IP da sua internet agora. Se ele mudar (outra rede, roteador reiniciou), atualize as regras.

---

## Passo 2: EC2 do RabbitMQ

1. **EC2 → Launch instance**
   - Nome: `lab-rabbit`
   - AMI: **Amazon Linux 2023**
   - Tipo: `t3.micro`
   - Key pair: `rabbitmq-lab`
   - Network: VPC default, **Auto-assign public IP: Enable**
   - Security group: **`sg-lab-rabbit`**
   - Storage: 8 GB está bom

2. Anote o **IP público** e o **IP privado** (aba *Details* da instância).

3. Acesse e instale o Docker:

   ```bash
   ssh -i rabbitmq-lab.pem ec2-user@IP_PUBLICO_DO_RABBIT

   sudo dnf install -y git
   git clone https://github.com/SEU_USUARIO/rabbitmq-lab.git
   cd rabbitmq-lab
   ./scripts/setup-ec2.sh
   exit   # saia e entre de novo para o grupo docker valer
   ```

4. Suba o RabbitMQ:

   ```bash
   ssh -i rabbitmq-lab.pem ec2-user@IP_PUBLICO_DO_RABBIT
   cd rabbitmq-lab/rabbit
   cp .env.example .env
   nano .env          # troque a senha do admin
   docker compose up -d
   docker compose logs -f    # espere "Server startup complete", depois Ctrl+C
   ```

5. Abra `http://IP_PUBLICO_DO_RABBIT:15672` e entre com o admin do `.env`. Esse é o painel do Rabbit, e você vai usar bastante.

---

## Passo 3: EC2 da API

1. **Launch instance** igual à anterior, mas com nome `lab-app` e Security group **`sg-lab-app`**.

2. Instale:

   ```bash
   ssh -i rabbitmq-lab.pem ec2-user@IP_PUBLICO_DO_APP
   sudo dnf install -y git
   git clone https://github.com/SEU_USUARIO/rabbitmq-lab.git
   cd rabbitmq-lab
   ./scripts/setup-ec2.sh
   exit
   ```

3. Configure e suba:

   ```bash
   ssh -i rabbitmq-lab.pem ec2-user@IP_PUBLICO_DO_APP
   cd rabbitmq-lab/app
   cp .env.example .env
   nano .env
   ```

   - `RABBITMQ_URL` e `RABBITMQ_MANAGEMENT_URL`: use o **IP privado** do Rabbit.
   - `RABBITMQ_PUBLIC_URL`: use o **IP público** do Rabbit (`amqp://IP_PUBLICO:5672`).

   ```bash
   docker compose up -d --build
   docker compose logs -f    # deve aparecer "[rabbitmq] conectado"
   ```

4. Abra `http://IP_PUBLICO_DO_APP`. O topo da tela deve ficar verde: **"API conectada ao RabbitMQ"**.

> Se o build travar por falta de memória na `t3.micro`, crie 1 GB de swap:
> `sudo dd if=/dev/zero of=/swapfile bs=1M count=1024 && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`

---

## Passo 4: Consumer (o "cliente") no seu notebook

1. Na tela, crie uma empresa e clique em **"Ligar fila"**.
2. Aparecem as credenciais. **Copie agora, porque a senha não aparece de novo.**
3. No seu notebook (Node 20+):

   ```bash
   cd rabbitmq-lab/consumer
   npm install
   cp .env.example .env
   # cole RABBITMQ_URL e QUEUE que apareceram na tela
   npm start
   ```

4. Crie uma visita na tela. Ela aparece no terminal do consumer.

O consumer **abriu uma conexão de saída** até o Rabbit. Seu notebook não abriu porta nenhuma. É assim que a integração do cliente vai funcionar.

---

## Experimentos

Esse é o objetivo do lab. Faça com o painel do Rabbit (`:15672`, aba *Queues*) aberto ao lado.

### 1. Cliente offline não perde eventos
1. Pare o consumer (Ctrl+C).
2. Clique em **"Criar 10"**. Na tela, "esperando na fila" vai para 10.
3. Rode `npm start` de novo: as 10 chegam.

### 2. A API cai, o Rabbit continua (o caso do Beanstalk)
1. Na EC2 app: `docker restart rabbitmq-lab-app`.
2. Mensagens que já estavam na fila continuam lá. A API reconecta sozinha.

### 3. O Rabbit cai
1. Na EC2 rabbit: `docker stop rabbitmq`. O topo da tela fica vermelho e o consumer mostra "desconectado".
2. Crie 3 visitas. A tela mostra **"3 publicações presas na memória da API"**.
3. `docker start rabbitmq`. As 3 são enviadas, o consumer reconecta e recebe.

### 4. O Rabbit cai **e** a API reinicia (perda de eventos)
1. `docker stop rabbitmq` e crie 3 visitas (ficam presas na memória).
2. Na EC2 app: `docker restart rabbitmq-lab-app`.
3. `docker start rabbitmq`. **As 3 se perderam**, porque estavam só na memória do processo.

> Isso pode acontecer em produção se uma instância do Beanstalk cair enquanto o Rabbit está fora. A solução clássica é o *outbox pattern*: gravar o evento no banco na mesma transação e publicar depois. Vale entender o risco antes de decidir se precisa.

### 5. Ack: mensagem não processada volta para a fila
1. No `consumer/.env`, coloque `PROCESSING_MS=3000` e rode de novo.
2. Clique em **"Criar 10"** e dê Ctrl+C no meio.
3. Rode de novo: as que não tinham recebido ack chegam marcadas como **(reentregue)**.

### 6. Persistência: reiniciar o Rabbit não apaga a fila
1. Pare o consumer e crie 5 visitas.
2. `docker restart rabbitmq`. As 5 continuam lá (fila `durable` + mensagem `persistent`).

### 7. Isolamento entre empresas
1. Crie uma segunda empresa e ligue a fila dela.
2. No `consumer/.env`, mantenha o `RABBITMQ_URL` da empresa A e troque o `QUEUE` para a fila da empresa B.
3. O Rabbit recusa com **ACCESS_REFUSED**: uma empresa não lê a fila da outra.

### 8. Desligar a fila corta o cliente
1. Com o consumer rodando, clique em **"Desligar fila"**.
2. O consumer cai e não consegue mais conectar, porque o usuário foi apagado.

### 9. Empresa sem fila
Crie visitas numa empresa com a fila desligada. A API publica normalmente, mas o Rabbit descarta (ninguém está ligado àquele routing key). No painel, aba *Exchanges* → `lab.events`, dá para ver as mensagens entrando sem destino.

---

## Etapa 2: TLS (cliente pela internet com segurança)

Na etapa 1, a senha do cliente trafega sem criptografia na 5672. Para fazer do jeito certo:

1. **Domínio grátis para teste:** use o [sslip.io](https://sslip.io). Se o IP público do Rabbit é `3.91.10.20`, o domínio `3-91-10-20.sslip.io` já aponta para ele, sem configurar nada.

2. No `sg-lab-rabbit`, adicione:
   - **80** de `0.0.0.0/0` (temporário: o Let's Encrypt precisa validar o domínio);
   - **5671** de My IP.

3. Na EC2 rabbit:

   ```bash
   cd rabbitmq-lab/rabbit
   ./scripts/issue-cert.sh 3-91-10-20.sslip.io seu@email.com
   docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
   ```

4. **Remova a regra da porta 80** e **a regra 5672 de My IP**. A partir daqui, o cliente só usa a 5671.

5. Na EC2 app, em `app/.env`: `RABBITMQ_PUBLIC_URL=amqps://3-91-10-20.sslip.io:5671`, depois `docker compose up -d`.

6. Desligue e ligue a fila da empresa para gerar credenciais novas, já com `amqps://`. Atualize o `consumer/.env` e rode. Repare que a API continua usando a 5672 privada, sem TLS, porque esse tráfego nunca sai da VPC.

> **Testar a porta 443:** em `docker-compose.tls.yml`, troque `5671:5671` por `443:5671`, libere a 443 no SG e use `amqps://...:443`. É útil quando o firewall do cliente só libera saída na 443.

> O certificado vale 90 dias. Para renovar, rode o `issue-cert.sh` de novo (com a porta 80 aberta) ou coloque no cron.

> **IP público muda** quando você para e liga a instância. Isso muda o domínio do sslip.io e o `.env`. Para não mudar, use um **Elastic IP** (cobrado enquanto existir).

---

## Rodar tudo local (sem AWS)

```bash
# RabbitMQ
cd rabbit && cp .env.example .env && docker compose up -d

# API (Node 20+)
cd app && cp .env.example .env
# no .env: troque IP_PRIVADO_DO_RABBIT e IP_PUBLICO_DO_RABBIT por localhost
cd api && npm install && npm run dev

# Front (outro terminal)
cd app/web && npm install && npm run dev   # abre em http://localhost:5173

# Consumer (outro terminal)
cd consumer && npm install && cp .env.example .env && npm start
```

---

## Limpeza

- **EC2 → Instances** → selecione as duas → **Terminate**.
- Libere Elastic IPs, se criou.
- Apague os Security Groups e o key pair, se quiser.

---

## Onde está cada conceito no código

| Conceito | Arquivo |
|---|---|
| Conexão com reconexão automática + publish | `app/api/src/rabbitmq.js` |
| Criar/remover usuário, fila, permissão e policy por empresa | `app/api/src/rabbitmqAdmin.js` |
| Ligar/desligar a fila (Rabbit antes do banco) | `app/api/src/server.js` (`PATCH /event-stream`) |
| Cliente consumindo com prefetch e ack | `consumer/index.js` |
| TLS no Rabbit | `rabbit/rabbitmq-tls.conf`, `rabbit/docker-compose.tls.yml` |
