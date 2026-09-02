package main

import (
	"flag"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/rames/endless-notebook/internal/auth"
	"github.com/rames/endless-notebook/internal/db"
	"github.com/rames/endless-notebook/internal/handler"
	"github.com/rames/endless-notebook/web"
)

// secureCookies marca os cookies de sessão como Secure (só trafegam via HTTPS).
// Ligue em produção com -secure-cookie, já que o TLS termina no Caddy.
var secureCookies bool

func main() {
	port := flag.String("port", ":8080", "server listen address (ex: 127.0.0.1:8080)")
	dbPath := flag.String("db", "notebook.db", "database path")
	inviteCode := flag.String("invite", os.Getenv("NOTEBOOK_INVITE_CODE"), "invite code required to register new users")
	secure := flag.Bool("secure-cookie", false, "mark session cookies as Secure (use behind HTTPS)")
	flag.Parse()

	secureCookies = *secure

	if *inviteCode == "" {
		log.Fatal("invite code must be set via -invite flag or NOTEBOOK_INVITE_CODE env var")
	}

	// inicializa banco de dados
	database, err := db.New(*dbPath)
	if err != nil {
		log.Fatalf("failed to initialize database: %v", err)
	}
	defer database.Close()

	// inicializa autenticação (usuários e sessões no banco)
	authMgr := auth.New(database.GetConn(), *inviteCode)

	// cria servidor HTTP
	srv := handler.New(database.GetConn(), authMgr)

	// rotas públicas
	http.HandleFunc("/health", srv.HealthHandler)
	http.HandleFunc("/login", loginHandler(authMgr))
	http.HandleFunc("/register", registerHandler(authMgr))
	http.HandleFunc("/logout", logoutHandler(authMgr))

	// arquivos estáticos, embutidos no binário (sem cache durante o dev)
	staticFS, err := fs.Sub(web.Files, "static")
	if err != nil {
		log.Fatalf("failed to open embedded static dir: %v", err)
	}
	fileServer := http.FileServerFS(staticFS)
	http.Handle("/static/", http.StripPrefix("/static/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	})))

	// página principal (protegida)
	http.Handle("/", authMgr.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		servePage(w, "index.html")
	})))

	// rotas protegidas
	http.Handle("/api/me", authMgr.Middleware(http.HandlerFunc(srv.Me)))

	http.Handle("/api/entries", authMgr.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			srv.CreateEntry(w, r)
		} else if r.Method == http.MethodGet {
			srv.ListEntries(w, r)
		}
	})))

	http.Handle("/api/entry", authMgr.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			srv.GetEntry(w, r)
		case http.MethodDelete:
			srv.DeleteEntry(w, r)
		case http.MethodPut, http.MethodPatch:
			srv.UpdateEntry(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})))

	log.Println("endless-notebook server starting on", *port)

	if err := http.ListenAndServe(*port, nil); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// servePage devolve um HTML embutido em web/.
func servePage(w http.ResponseWriter, name string) {
	data, err := web.Files.ReadFile(name)
	if err != nil {
		http.Error(w, "page not found: "+name, http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(data)
}

func setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   secureCookies,
		SameSite: http.SameSiteLaxMode,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secureCookies,
		SameSite: http.SameSiteLaxMode,
	})
}

func loginHandler(authMgr *auth.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			token, expires, err := authMgr.Login(r.FormValue("username"), r.FormValue("password"))
			if err != nil {
				http.Redirect(w, r, "/login?error=invalid", http.StatusSeeOther)
				return
			}
			setSessionCookie(w, token, expires)
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		servePage(w, "login.html")
	}
}

func registerHandler(authMgr *auth.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			username := r.FormValue("username")
			password := r.FormValue("password")

			if err := authMgr.Register(username, password, r.FormValue("invite")); err != nil {
				http.Redirect(w, r, "/register?error="+url.QueryEscape(err.Error()), http.StatusSeeOther)
				return
			}

			// auto-login logo após o registro
			token, expires, err := authMgr.Login(username, password)
			if err != nil {
				http.Redirect(w, r, "/login", http.StatusSeeOther)
				return
			}
			setSessionCookie(w, token, expires)
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		servePage(w, "register.html")
	}
}

func logoutHandler(authMgr *auth.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cookie, err := r.Cookie("session"); err == nil {
			authMgr.Logout(cookie.Value)
		}
		clearSessionCookie(w)
		http.Redirect(w, r, "/login", http.StatusSeeOther)
	}
}
