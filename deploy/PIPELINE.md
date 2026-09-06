# Pipeline CI/CD — GitHub Actions

Companheiro do [`deploy/README.md`](./README.md). Aqui o foco é **só o pipeline**:
o que o `.github/workflows/deploy.yml` faz, linha a linha, e como recriá-lo do
zero manualmente caso ele não exista (ou você queira entender cada peça antes de
confiar nele).

O workflow já está versionado em [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).
Se ele já está lá, pule para [Parte 2](#parte-2--configuração-manual-passo-a-passo)
(a parte que exige cliques no GitHub e comandos na VPS).

---

## Parte 1 — Como o pipeline funciona

### Visão geral

```
push na main  ─┐
               ├─▶  job "build"   (sempre roda)
manual (Actions │      go vet ─▶ go test ─▶ build linux/amd64 estático ─▶ sobe artifact
 → Run workflow)┘                                   │
                                                    ▼
                     job "deploy"  (só se DEPLOY_ENABLED == "true")
                        baixa artifact ─▶ configura SSH ─▶ scp p/ /tmp da VPS
                        ─▶ sudo install + systemctl restart ─▶ curl /health
```

- **Dois jobs.** `build` compila e valida; `deploy` publica. `deploy` depende de
  `build` (`needs: build`) e só recebe o binário pronto via *artifact*.
- **`build` sempre executa** em push na `main` — serve de CI (te avisa se
  quebrou a compilação mesmo antes da VPS existir).
- **`deploy` tem um interruptor**: a *repository variable* `DEPLOY_ENABLED`.
  Enquanto não for `true`, o job é pulado. É o kill-switch para ligar o
  auto-deploy só quando a infra estiver pronta — e desligar rápido se precisar.
- **Nada de segredo no repositório.** Chave SSH, host e domínio vêm de
  *GitHub Secrets*, injetados só em runtime no runner.

### Anatomia do `deploy.yml`

#### Gatilhos e trava de concorrência

```yaml
on:
  push:
    branches: [main]      # todo push na main dispara
  workflow_dispatch:       # botão "Run workflow" na aba Actions

concurrency:
  group: production-deploy
  cancel-in-progress: false   # não cancela um deploy no meio; enfileira o próximo
```

`cancel-in-progress: false` é deliberado: cancelar um `systemctl restart` pela
metade é pior do que esperar o anterior terminar.

#### Permissões mínimas do token

```yaml
permissions:
  contents: read          # o GITHUB_TOKEN só pode ler o repo, nada mais
```

#### Job `build`

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # clona o repo no runner

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod          # usa a versão declarada no go.mod
          cache: true                      # cacheia ~/go/pkg/mod entre runs

      - name: Vet
        run: go vet ./...

      - name: Test
        run: go test ./...                 # passa mesmo sem testes ("no test files")

      - name: Build static binary (linux/amd64)
        run: |
          CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
            go build -trimpath -ldflags='-s -w' -o dist/endless-notebook ./cmd/server
          test -x dist/endless-notebook && file dist/endless-notebook
```

- `CGO_ENABLED=0` → binário **estático**, sem depender da glibc da VPS
  (o SQLite aqui é `modernc.org/sqlite`, Go puro — por isso dá pra desligar o CGO).
- `GOOS=linux GOARCH=amd64` → cross-compila do runner (que também é isso, mas
  deixa explícito e correto se um dia o runner mudar).
- `-trimpath` remove caminhos absolutos do binário; `-ldflags='-s -w'` remove a
  tabela de símbolos e o DWARF → binário menor.

```yaml
      - uses: actions/upload-artifact@v4
        with:
          name: endless-notebook
          path: dist/endless-notebook
          retention-days: 7
          if-no-files-found: error         # falha o job se o build não gerou nada
```

O artifact é a única coisa que passa do `build` para o `deploy`.

#### Job `deploy`

```yaml
  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' && vars.DEPLOY_ENABLED == 'true'
    environment: production                # amarra ao Environment (reviewers opcionais)
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: endless-notebook
          path: dist
```

A condição `if:` combina duas guardas: só na `main` **e** só com o interruptor ligado.

```yaml
      - name: Configure SSH
        run: |
          install -d -m 700 ~/.ssh
          printf '%s\n' "${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_deploy
          chmod 600 ~/.ssh/id_deploy
          ssh-keyscan -p "${{ secrets.SSH_PORT || '22' }}" -H "${{ secrets.SSH_HOST }}" >> ~/.ssh/known_hosts 2>/dev/null
```

Escreve a chave privada num arquivo e coleta a *host key* da VPS. O `ssh-keyscan`
é TOFU (confia no primeiro contato) — veja [Endurecendo](#endurecendo-opcional)
para fixá-la via secret.

```yaml
      - name: Upload binary
        run: |
          chmod +x dist/endless-notebook
          scp -i ~/.ssh/id_deploy -P "${{ secrets.SSH_PORT || '22' }}" \
            dist/endless-notebook \
            "${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }}:/tmp/endless-notebook.new"
```

Sobe para `/tmp/endless-notebook.new` — um caminho que o usuário `deploy`
escreve sem sudo.

```yaml
      - name: Release (install + restart)
        run: |
          ssh -i ~/.ssh/id_deploy -p "${{ secrets.SSH_PORT || '22' }}" \
            "${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }}" \
            "set -e && \
             sudo /usr/bin/install -o endless -g endless -m 0755 /tmp/endless-notebook.new /opt/endless-notebook/endless-notebook && \
             rm -f /tmp/endless-notebook.new && \
             sudo /usr/bin/systemctl restart endless-notebook && \
             sleep 2 && \
             sudo /usr/bin/systemctl is-active endless-notebook"
```

Cada `sudo` aqui casa **exatamente** com uma linha do
[`deploy/sudoers-deploy`](./sudoers-deploy) — o usuário `deploy` não tem sudo
livre, só esses 4 comandos, sem senha. `install` troca o binário de forma
atômica (não um `cp` que poderia pegar o processo lendo pela metade);
`is-active` faz o step falhar se o serviço não subiu.

```yaml
      - name: Health check
        run: |
          curl -fsS --retry 10 --retry-all-errors --retry-connrefused --retry-delay 6 \
            "https://${{ secrets.APP_DOMAIN }}/health"
```

`-f` faz o `curl` retornar erro em HTTP >= 400 → o run fica vermelho se a app
não respondeu `200` em `/health` depois de ~1 min de tentativas.

### O que o pipeline **não** faz (é responsabilidade da VPS, via `provision.sh`)

- criar o usuário `deploy` e instalar a chave pública dele;
- o `sudoers.d` que autoriza os 4 comandos;
- os units systemd, o Caddy, o firewall, o arquivo `.env` com o `INVITE_CODE`.

O pipeline **presume** que tudo isso já existe. É o `deploy/provision.sh` que põe.

---

## Parte 2 — Configuração manual passo a passo

Use esta parte se o `deploy.yml` **não** existe no repo, ou para conferir os
pré-requisitos de quem já tem o arquivo.

### Pré-requisitos

- [ ] Repositório no GitHub (pode ser privado).
- [ ] VPS já provisionada com [`deploy/provision.sh`](./provision.sh) — isso cria
      o usuário `deploy`, o `sudoers.d` e os serviços. **Sem isso o job `deploy`
      falha** por permissão.
- [ ] DNS de `APP_DOMAIN` apontando para a VPS (senão o `Health check` via HTTPS
      nunca passa — o Caddy não emite o certificado).
- [ ] `gh` CLI autenticado (`gh auth login`) — opcional, mas os passos 4–6 ficam
      em uma linha cada.

### Passo 1 — Criar o arquivo do workflow

Na raiz do repositório:

```bash
mkdir -p .github/workflows
```

O caminho é obrigatório: o GitHub só lê workflows em `.github/workflows/*.yml`.
O nome do arquivo é livre; vamos usar `deploy.yml`.

### Passo 2 — Escrever o job `build`

Cole em `.github/workflows/deploy.yml`:

```yaml
name: deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: production-deploy
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - name: Vet
        run: go vet ./...

      - name: Test
        run: go test ./...

      - name: Build static binary (linux/amd64)
        run: |
          CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
            go build -trimpath -ldflags='-s -w' -o dist/endless-notebook ./cmd/server
          test -x dist/endless-notebook && file dist/endless-notebook

      - uses: actions/upload-artifact@v4
        with:
          name: endless-notebook
          path: dist/endless-notebook
          retention-days: 7
          if-no-files-found: error
```

**Commit e push só disso já é útil**: você tem CI. Confira na aba **Actions**
que o job `build` fica verde. O `deploy` ainda nem existe.

### Passo 3 — Acrescentar o job `deploy`

No mesmo arquivo, **abaixo** do job `build` (mesmo nível de indentação, dentro de
`jobs:`):

```yaml
  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' && vars.DEPLOY_ENABLED == 'true'
    environment: production
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: endless-notebook
          path: dist

      - name: Configure SSH
        run: |
          install -d -m 700 ~/.ssh
          printf '%s\n' "${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_deploy
          chmod 600 ~/.ssh/id_deploy
          ssh-keyscan -p "${{ secrets.SSH_PORT || '22' }}" -H "${{ secrets.SSH_HOST }}" >> ~/.ssh/known_hosts 2>/dev/null

      - name: Upload binary
        run: |
          chmod +x dist/endless-notebook
          scp -i ~/.ssh/id_deploy -P "${{ secrets.SSH_PORT || '22' }}" \
            dist/endless-notebook \
            "${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }}:/tmp/endless-notebook.new"

      - name: Release (install + restart)
        run: |
          ssh -i ~/.ssh/id_deploy -p "${{ secrets.SSH_PORT || '22' }}" \
            "${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }}" \
            "set -e && \
             sudo /usr/bin/install -o endless -g endless -m 0755 /tmp/endless-notebook.new /opt/endless-notebook/endless-notebook && \
             rm -f /tmp/endless-notebook.new && \
             sudo /usr/bin/systemctl restart endless-notebook && \
             sleep 2 && \
             sudo /usr/bin/systemctl is-active endless-notebook"

      - name: Health check
        run: |
          curl -fsS --retry 10 --retry-all-errors --retry-connrefused --retry-delay 6 \
            "https://${{ secrets.APP_DOMAIN }}/health"
```

> Os caminhos absolutos (`/usr/bin/install`, `/usr/bin/systemctl`) e o
> `/tmp/endless-notebook.new` **têm que bater exatamente** com o
> [`deploy/sudoers-deploy`](./sudoers-deploy). Se você mudar um, mude o outro.

### Passo 4 — Gerar a chave SSH dedicada ao CI

No **seu computador** (não na VPS). Par exclusivo do deploy, **sem passphrase**
(o Actions não tem como digitar):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/endless-deploy -N "" -C "deploy@github-actions"
```

- `~/.ssh/endless-deploy` (privada) → vira o secret `SSH_PRIVATE_KEY`.
- `~/.ssh/endless-deploy.pub` (pública) → vai para a VPS como `authorized_keys`
  do usuário `deploy`. O `provision.sh` faz isso quando você passa
  `DEPLOY_PUBKEY="$(cat ~/.ssh/endless-deploy.pub)"`.

Se a VPS já foi provisionada sem essa chave, adicione à mão:

```bash
ssh-copy-id -i ~/.ssh/endless-deploy.pub deploy@SEU_IP
# ou: cole o conteúdo do .pub em /home/deploy/.ssh/authorized_keys na VPS
```

Teste antes de seguir:

```bash
ssh -i ~/.ssh/endless-deploy deploy@SEU_IP 'sudo /usr/bin/systemctl is-active endless-notebook; echo OK'
```

Tem que responder sem pedir senha (nem de SSH, nem de sudo).

### Passo 5 — Cadastrar os Secrets no GitHub

**Settings → Secrets and variables → Actions → aba Secrets → New repository secret**:

| Secret | Valor | Obrigatório |
|---|---|---|
| `SSH_HOST` | IP ou hostname da VPS | sim |
| `SSH_USER` | `deploy` | sim |
| `SSH_PRIVATE_KEY` | conteúdo **inteiro** de `~/.ssh/endless-deploy` (com as linhas `BEGIN/END`) | sim |
| `APP_DOMAIN` | `notebook.seu-dominio.com` (sem `https://`) | sim |
| `SSH_PORT` | porta SSH, se **não** for 22 | não |

Pela linha de comando (`gh`):

```bash
gh secret set SSH_HOST        --body "203.0.113.10"
gh secret set SSH_USER        --body "deploy"
gh secret set SSH_PRIVATE_KEY < ~/.ssh/endless-deploy
gh secret set APP_DOMAIN      --body "notebook.seu-dominio.com"
# gh secret set SSH_PORT      --body "2222"   # só se mudou a porta
```

### Passo 6 — Criar a Variable `DEPLOY_ENABLED` (o interruptor)

Mesma tela, **aba Variables → New repository variable**:

| Variable | Valor |
|---|---|
| `DEPLOY_ENABLED` | `true` |

```bash
gh variable set DEPLOY_ENABLED --body "true"
```

Com `false` (ou ausente) o job `deploy` aparece como **Skipped** e só o `build`
roda. Para **desligar o auto-deploy** a qualquer momento: mude para `false`.

### Passo 7 — (Opcional) Environment `production` com aprovação manual

O workflow já declara `environment: production`. Se você criar esse Environment
e adicionar *required reviewers*, cada deploy **pausa esperando um clique de
aprovação** — bom para produção.

**Settings → Environments → New environment → `production`**
→ marque **Required reviewers** e adicione você mesmo.

Sem criar o Environment, a referência é inofensiva (o job roda direto).

### Passo 8 — Conferir o lado servidor

O job `deploy` só passa se, na VPS:

- existe o usuário `deploy` com a **pública** do passo 4 em
  `~/.ssh/authorized_keys`;
- existe `/etc/sudoers.d/endless-notebook-deploy` com as 4 regras
  (`sudo visudo -cf /etc/sudoers.d/endless-notebook-deploy` valida);
- existe o serviço `endless-notebook` (`systemctl status endless-notebook` —
  pode estar `activate (running)` com o placeholder ou falhando por falta de
  binário; ambos ok, o deploy substitui);
- o `/opt/endless-notebook/` pertence a `endless:endless`.

Tudo isso é o que o [`deploy/provision.sh`](./provision.sh) monta. Se você rodou
o script, está pronto.

### Passo 9 — Primeiro run e verificação

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: pipeline de deploy via GitHub Actions"
git push origin main
```

Na aba **Actions**:

1. `build` fica verde (compilou, subiu o artifact).
2. `deploy` roda em seguida (ou espera aprovação, se você fez o passo 7).
3. `Health check` verde = a app respondeu `200` em `https://APP_DOMAIN/health`.

Também dá pra disparar sem push: **Actions → deploy → Run workflow → branch `main`**
(é o `workflow_dispatch`).

---

## Operação do dia a dia

| Ação | Como |
|---|---|
| **Deploy** | `git push origin main` |
| **Deploy manual** | Actions → deploy → *Run workflow* |
| **Pausar auto-deploy** | `gh variable set DEPLOY_ENABLED --body false` |
| **Rollback** | Actions → run antigo que estava bom → *Re-run all jobs* (rebaixa o binário daquele commit). Ou `git revert <sha> && git push`. |
| **Ver o que subiu** | cada run guarda o artifact `endless-notebook` por 7 dias |
| **Logs da app pós-deploy** | na VPS: `sudo journalctl -u endless-notebook -f` |

> **Atenção ao rollback por "Re-run":** o artifact expira em 7 dias
> (`retention-days: 7`). Para runs mais antigos, faça `git revert` — o `build`
> recompila aquele código.

---

## Troubleshooting

| Sintoma no run | Causa provável | Correção |
|---|---|---|
| `deploy` aparece **Skipped** | `DEPLOY_ENABLED` != `true`, ou push não foi na `main` | passo 6 |
| `Permission denied (publickey)` no *Configure SSH*/*Upload* | `SSH_PRIVATE_KEY` incompleta, ou a **pública** não está no `authorized_keys` do `deploy` | recadastre o secret com o arquivo inteiro; `ssh-copy-id` na VPS |
| `Host key verification failed` | `ssh-keyscan` não alcançou o host (porta errada, firewall) | confira `SSH_HOST`/`SSH_PORT`; `ufw allow OpenSSH` na VPS |
| `sudo: a password is required` no *Release* | `sudoers.d` ausente ou comando não bate com a regra | reinstale [`sudoers-deploy`](./sudoers-deploy); os caminhos no YAML e no sudoers têm que ser idênticos |
| `install: cannot create ... Permission denied` | `/opt/endless-notebook` não é de `endless:endless` | `sudo chown -R endless:endless /opt/endless-notebook` |
| `Failed to restart endless-notebook.service` / `is-active` retorna `failed` | binário não inicia (env faltando, porta ocupada) | `sudo journalctl -u endless-notebook -n 50` na VPS; cheque `/opt/endless-notebook/endless-notebook.env` |
| `Health check` falha só no **primeiro** deploy | Caddy ainda emitindo o certificado Let's Encrypt | espere 1–2 min e *Re-run* o job; confirme o DNS com `dig +short APP_DOMAIN` |
| `Health check` falha sempre, mas o serviço está `active` | Caddy não está fazendo proxy, ou domínio errado no secret | `sudo journalctl -u caddy -f`; confira `APP_DOMAIN` (sem `https://`) |
| `go vet`/`go test` vermelho | erro de código | corrija localmente; roda igual com `go vet ./... && go test ./...` |

---

## Endurecendo (opcional)

- **Fixar a host key** em vez do TOFU do `ssh-keyscan`: crie o secret
  `SSH_KNOWN_HOSTS` com a saída de `ssh-keyscan -p PORTA SEU_IP` e, no step
  *Configure SSH*, troque a linha do `ssh-keyscan` por:
  ```bash
  printf '%s\n' "${{ secrets.SSH_KNOWN_HOSTS }}" >> ~/.ssh/known_hosts
  ```
- **`workflow_dispatch` com confirmação**: adicione um `inputs:` obrigatório
  (ex.: digitar `deploy`) para evitar clique acidental no *Run workflow*.
- **Separar staging**: um segundo workflow em `push` de um branch `staging`
  apontando para outra VPS/porta, com seus próprios secrets de Environment.
- **Assinar/checar o binário**: gere um `sha256sum` no `build`, suba junto no
  artifact e valide na VPS antes do `install`.
- **Notificação**: um step final `if: failure()` mandando aviso (e-mail, webhook)
  quando o deploy quebra.
