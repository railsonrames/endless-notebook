// Package web embute os arquivos do frontend no binário, para que o deploy seja
// um único executável estático (sem depender do WorkingDirectory no servidor).
package web

import "embed"

//go:embed index.html login.html register.html static
var Files embed.FS
