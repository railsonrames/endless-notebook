# Deploy — endless-notebook

Como sair de "acabei de contratar a VPS" até "online com CI/CD pelo GitHub Actions".

## Arquitetura

```
Internet ──HTTPS──▶ Caddy (:443, cert Let's Encrypt automático)
                      │  reverse_proxy
                      ▼
              endless-notebook (127.0.0.1:8080)   ← binário único, frontend embutido
                      │
                      ▼
              /opt/endless-notebook/data/notebook.db  (SQLite)
```

- **Um binário estático**, sem runtime externo. O HTML/JS é embutido via `go:embed`.
- **Caddy** na frente cuida do TLS (Let's Encrypt) e do proxy reverso.
- **systemd** mantém o processo vivo (`Restart=on-failure`).
- **GitHub Actions**: a cada push na `main` → compila `linux/amd64` estático → `scp` para a VPS → `systemctl restart` → health check.
- **Backup** diário do `.db` por timer systemd (retém 14).

Arquivos deste diretório:

| arquivo | vai para | o quê |
|---|---|---|
| `provision.sh` | roda 1x na VPS | prepara tudo (usuários, firewall, Caddy, systemd) |
| `endless-notebook.service` | `/etc/systemd/system/` | unit da app |
| `endless-notebook-backup.{service,timer}` | `/etc/systemd/system/` | backup diário |
| `backup.sh` | `/opt/endless-notebook/` | script de backup do SQLite |
| `Caddyfile` | `/etc/caddy/Caddyfile` | proxy + TLS (com placeholders) |
| `sudoers-deploy` | `/etc/sudoers.d/` | permissões mínimas do usuário de CI |

---

## Passo 0 — Contratar a VPS

- **OVHcloud → VPS**. O menor plano (**VLE-2 / VPS Value**, ~1 vCPU, 2 GB RAM) sobra para este app.
- Imagem: **Debian 12** (ou Ubuntu 22.04/24.04).
- Adicione sua **chave SSH** já na criação (evita senha de root por e-mail).
- Anote o **IP** (IPv4 e IPv6, se houver).

## Passo 1 — Primeiro acesso e hardening de SSH

```bash
ssh debian@SEU_IP        # ou root@SEU_IP, depende da imagem
sudo -i
```

Se só tem `root`, crie seu usuário pessoal com sudo (o `deploy` e o `endless` são criados pelo script depois):

```bash
adduser rames
usermod -aG sudo rames
install -d -m 700 /home/rames/.ssh
cp ~/.ssh/authorized_keys /home/rames/.ssh/
chown -R rames:rames /home/rames/.ssh
```

Endureça o SSH — edite `/etc/ssh/sshd_config` (ou um arquivo em `/etc/ssh/sshd_config.d/`):

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
```

```bash
systemctl restart ssh
```

> Deixe **esta sessão aberta** e teste o login em outro terminal antes de fechar.

## Passo 2 — DNS

No painel do seu domínio, crie:

| tipo | nome | valor |
|---|---|---|
| `A` | `notebook` (ou `@`) | IPv4 da VPS |
| `AAAA` | idem | IPv6 da VPS (se tiver) |

Espere propagar (`dig +short notebook.seu-dominio.com` deve devolver o IP). O Caddy só consegue emitir o certificado depois disso.

## Passo 3 — Chave SSH para o CI

No **seu computador**, gere um par dedicado ao deploy (sem passphrase, senão o Actions não usa):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/endless-deploy -N "" -C "deploy@github-actions"
```

- **Privada** (`~/.ssh/endless-deploy`) → vai para o GitHub como secret `SSH_PRIVATE_KEY`.
- **Pública** (`~/.ssh/endless-deploy.pub`) → vai para o `provision.sh` como `DEPLOY_PUBKEY`.

## Passo 4 — Provisionar a VPS

Traga o repo para a VPS (só para rodar o script; o deploy real não depende disso):

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/rames/endless-notebook.git
cd endless-notebook
```

> Repo privado? Em vez do `git clone`, copie a pasta `deploy/` mantendo a
> estrutura (o script procura os `.service`/`Caddyfile` em `../deploy/`
> relativo a si mesmo):
> ```
> ssh rames@SEU_IP 'mkdir -p ~/endless-notebook'
> scp -r deploy rames@SEU_IP:~/endless-notebook/
> ```
> e no passo abaixo use `bash ~/endless-notebook/deploy/provision.sh`.

```bash
export APP_DOMAIN=notebook.seu-dominio.com
export ACME_EMAIL=voce@seu-dominio.com
export INVITE_CODE='troque-por-um-codigo-forte'
export DEPLOY_PUBKEY="$(cat ~/endless-deploy.pub)"
sudo --preserve-env=APP_DOMAIN,ACME_EMAIL,INVITE_CODE,DEPLOY_PUBKEY bash ~/endless-notebook/deploy/provision.sh
```

O script é idempotente. Ao final ele:

- criou os usuários `endless` (serviço) e `deploy` (CI, com a chave pública);
- ligou o firewall (`ufw`: SSH, 80, 443) e o `fail2ban`;
- instalou o Caddy e gerou `/etc/caddy/Caddyfile` com seu domínio/e-mail;
- instalou e habilitou os units systemd (app + timer de backup);
- gravou o segredo em `/opt/endless-notebook/endless-notebook.env`.

A app ainda **não** está no ar — falta o binário, que vem pelo CI.

## Passo 5 — Secrets no GitHub

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| secret | valor |
|---|---|
| `SSH_HOST` | IP ou hostname da VPS |
| `SSH_USER` | `deploy` |
| `SSH_PRIVATE_KEY` | conteúdo de `~/.ssh/endless-deploy` (chave privada inteira) |
| `APP_DOMAIN` | `notebook.seu-dominio.com` |
| `SSH_PORT` | *(opcional)* porta SSH, se não for 22 |

E em **Variables** (mesma tela), crie a *repository variable*:

| variable | valor |
|---|---|
| `DEPLOY_ENABLED` | `true` |

Enquanto `DEPLOY_ENABLED` não for `true`, o job `deploy` é pulado (o `build`
continua rodando). É o interruptor para ligar o auto-deploy só quando a VPS
estiver pronta — e para desligar rápido se precisar.

> Opcional: crie o *Environment* `production` (Settings → Environments) e adicione *required reviewers* para exigir aprovação manual antes de cada deploy. O workflow já referencia `environment: production`.

## Passo 6 — Criar o repositório no GitHub e fazer push

1. github.com → **New repository** → nome `endless-notebook` → **Private** →
   **NÃO** marque "Add a README / .gitignore / license" (o repo local já tem commits).
2. No seu computador, na raiz do projeto:

```bash
git remote add origin git@github.com:SEU_USUARIO/endless-notebook.git
git push -u origin main
```

> Sem chave SSH no GitHub? Use HTTPS: `git remote add origin https://github.com/SEU_USUARIO/endless-notebook.git`
> (vai pedir usuário + token — crie um em github.com/settings/tokens).

Cada push na `main` dispara o workflow **deploy**:

1. `build` — `go vet`, `go test`, compila o binário estático e sobe como artifact. **Sempre roda.**
2. `deploy` — só roda com `DEPLOY_ENABLED=true` (passo 5). Baixa o binário, `scp` para `/tmp`, `sudo install` em `/opt/endless-notebook/`, `systemctl restart`, e bate em `https://APP_DOMAIN/health`.

Acompanhe em **Actions**. Se o health check falhar no primeiríssimo run por causa da emissão do certificado, rode o workflow de novo (**Actions → deploy → Run workflow**) após 1–2 min.

## Passo 7 — Criar sua conta

```
https://notebook.seu-dominio.com/register
```

Usuário + senha + **código de convite** (o `INVITE_CODE` do passo 4). Depois disso, `/login` normal. Cada usuário só vê as próprias anotações.

---

## Operação

```bash
# status / logs da app
sudo systemctl status endless-notebook
sudo journalctl -u endless-notebook -f

# Caddy
sudo systemctl reload caddy
sudo journalctl -u caddy -f

# trocar o código de convite
sudo nano /opt/endless-notebook/endless-notebook.env
sudo systemctl restart endless-notebook

# backups
systemctl list-timers endless-notebook-backup
ls -lh /opt/endless-notebook/backups/
sudo systemctl start endless-notebook-backup   # backup sob demanda
```

**Restaurar um backup:**

```bash
sudo systemctl stop endless-notebook
gunzip -c /opt/endless-notebook/backups/notebook-XXXXXXXX-XXXXXX.db.gz \
  | sudo -u endless tee /opt/endless-notebook/data/notebook.db > /dev/null
sudo systemctl start endless-notebook
```

**Rollback de versão:** reexecute um run antigo do workflow em **Actions** (Re-run jobs), ou faça `git revert` + push.

## Sugestões (opcionais)

- **Monitor externo**: cadastre `https://notebook.seu-dominio.com/health` no [healthchecks.io](https://healthchecks.io) ou UptimeRobot (grátis) para receber alerta se cair.
- **Backup off-site**: `rclone`/`restic` empurrando `/opt/endless-notebook/backups/` para um bucket (OVH Object Storage, Backblaze B2). Backup na mesma máquina não protege contra perda do disco.
- **Snapshots da OVH**: habilite o snapshot automático da VPS no painel (proteção de infra, complementar ao backup do `.db`).
- **`known_hosts` fixo no CI**: em vez do `ssh-keyscan` do workflow, adicione um secret `SSH_KNOWN_HOSTS` com a saída de `ssh-keyscan SEU_IP` e escreva esse valor — evita TOFU.
- **Atualizações**: `unattended-upgrades` para patches de segurança do SO automáticos.
- **2ª instância de staging**: um `notebook-staging.seu-dominio.com` apontando para outra porta/serviço, deployado a partir de um branch `staging`, para testar antes da `main`.
