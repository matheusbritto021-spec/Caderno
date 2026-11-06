# Caderno de Clínica

Caderno pessoal de pérolas clínicas, organizado pelas grandes áreas da Clínica Médica. É um web app instalável (PWA): abre no navegador, instala na tela de início do iPhone e funciona sem internet.

## Como funciona

- O app e as notas ficam guardados no aparelho. Abre e salva mesmo sem rede.
- Com login, sincroniza com um banco Supabase: envia o que mudou no aparelho e recebe o que mudou lá, inclusive as notas que o Claude anotar.
- O que for escrito sem rede entra numa fila e é enviado na próxima conexão.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `index.html` | Tela e estilos |
| `app.js` | Lógica: notas, busca, armazenamento local, sincronização |
| `config.js` | URL e chave pública do Supabase |
| `sw.js` | Service worker: guarda o app para abrir offline |
| `manifest.webmanifest`, `icons/` | Instalação e ícone |
| `vendor/` | Biblioteca do Supabase (supabase-js 2.45.4, licença MIT), guardada no app para funcionar offline |
| `supabase/schema.sql` | Tabela `notas` e regras de acesso por usuário |

## Publicar uma versão nova

Altere os arquivos, aumente `VERSION` em `sw.js` e faça o commit na branch `main`. O GitHub Pages publica sozinho; o app instalado pega a versão nova na abertura seguinte.

## Privacidade

Nunca anote dados que identifiquem pacientes (nome, iniciais, prontuário, leito).
