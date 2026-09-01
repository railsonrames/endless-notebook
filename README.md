# Endless Notebook

Aplicação pessoal de anotações estilo diário/log com timestamp automático, tags e valores monetários.

## Features

- ✅ Autenticação single-user com senha bcrypt
- ✅ Entradas com timestamp automático (YYYYMMDDHHMM)
- ✅ Parse de tags (#tag) e valores monetários ([valor])
- ✅ API REST CRUD protegida por sessão
- ✅ Filtro por tags
- ✅ Frontend com interface estilo notebook pixel art
- ✅ Banco de dados SQLite embutido (sem dependências externas)

## Stack

- **Backend**: Go 1.27+
- **Banco de dados**: SQLite via `modernc.org/sqlite`
- **Frontend**: HTML + CSS + JavaScript com Canvas
- **Autenticação**: bcrypt + cookies assinados

## Estrutura do projeto

```
cmd/server/main.go          — ponto de entrada
internal/
  ├── db/db.go              — inicialização do banco e migrations
  ├── auth/auth.go          — autenticação e sessões
  ├── entry/
  │   ├── entry.go          — struct e parse
  │   └── repository.go     — operações no banco
  ├── handler/handler.go    — handlers HTTP
  └── report/report.go      — geração de relatórios
web/
  ├── index.html            — página principal
  └── static/notebook.js    — lógica frontend
```

## Como executar

### 1. Compilar

```bash
go mod tidy
go build -o ./bin/server ./cmd/server/
```

### 2. Rodar o servidor

```bash
./bin/server -port :8080 -db notebook.db -invite "codigo_de_convite"
```

Ou via variável de ambiente:

```bash
export NOTEBOOK_INVITE_CODE="codigo_de_convite"
./bin/server -port :8080 -db notebook.db
```

O `-invite` / `NOTEBOOK_INVITE_CODE` é obrigatório: é o código que novos usuários
precisam informar em `/register` para criar conta.

### 3. Acessar

- **URL**: http://localhost:8080
- **Criar conta**: `/register` — usuário, senha e o código de convite
- **Login**: `/login` — usuário + senha
- Cada usuário só vê as próprias anotações
- **Usar**: Digite anotações no format:
  - Tags: `#tag` (ex: `#compras`)
  - Valores: `[valor]` (ex: `[10.50]`)
  - Exemplo completo: `compra no mercado #compras [5.50]`

## API Endpoints

### Públicas

```
GET    /register       — Página de registro
POST   /register       — Criar conta (form data: username, password, invite)
GET    /login          — Página de login
POST   /login          — Fazer login (form data: username, password)
GET    /logout         — Encerrar sessão
GET    /health         — Status do servidor
GET    /static/*       — Arquivos estáticos (CSS, JS)
```

### Protegidas (requerem autenticação via cookie)

```
GET    /api/me                      — Usuário logado ({id, username})
GET    /api/entries                 — Listar entries do usuário
GET    /api/entries?tag=manutencao  — Listar entries do usuário com tag
POST   /api/entries                 — Criar nova entry
                                      body: {"text": "..."}
GET    /api/entry?id=1              — Obter entry por ID (do usuário)
DELETE /api/entry?id=1              — Deletar entry (do usuário)
```

## Exemplo de uso via curl

```bash
# 0. Criar conta (uma vez)
curl -X POST http://localhost:8080/register \
  -d "username=alice&password=minhasenha&invite=codigo_de_convite" \
  -c cookies.txt

# 1. Login (se já tiver conta)
curl -X POST http://localhost:8080/login \
  -d "username=alice&password=minhasenha" \
  -c cookies.txt

# 2. Criar entry
curl -X POST http://localhost:8080/api/entries \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"text":"levei o carro na oficina #manutencao [150]"}'

# 3. Listar entries
curl http://localhost:8080/api/entries -b cookies.txt

# 4. Filtrar por tag
curl "http://localhost:8080/api/entries?tag=manutencao" -b cookies.txt
```

## Desenvolvimento

### Ambiente

- macOS com Go instalado via Homebrew
- SQLite via `modernc.org/sqlite` (driver puro Go, sem cgo)

### Compilar para múltiplas plataformas

```bash
# Linux
GOOS=linux GOARCH=amd64 go build -o bin/server-linux ./cmd/server/

# Windows
GOOS=windows GOARCH=amd64 go build -o bin/server.exe ./cmd/server/

# macOS ARM64
GOOS=darwin GOARCH=arm64 go build -o bin/server-arm64 ./cmd/server/
```

## Próximas fases (roadmap)

- [ ] Fase 2: Melhorias UI (Canvas estilo Full Throttle)
- [ ] Fase 3: Deploy com GitHub Actions + Caddy
- [ ] Fase 4: Módulo de relatórios financeiros
- [ ] Fase 5: Gestão de assinaturas e recorrências
