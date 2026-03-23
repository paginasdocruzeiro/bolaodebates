# Bolão do Cruzeiro Debates — versão com Firebase

Esta versão troca a sincronização local por uma base de dados central no Firebase Realtime Database.

## O que muda

- todos os utilizadores passam a ver as mesmas rodadas
- as apostas ficam sincronizadas em tempo real
- ranking, histórico e estatísticas tornam-se únicos para todos
- os exemplos de apostas foram removidos
- cada nova rodada nasce vazia, sem herdar palpites anteriores
- as rodadas antigas continuam gravadas no histórico

## Ficheiros principais

- `index.html`
- `styles.css`
- `app.js`
- `firebase-config.js`
- `Bolao1.png`

## Como ligar ao Firebase

1. Crie um projeto no Firebase.
2. Ative **Realtime Database**.
3. Copie as credenciais web do projeto.
4. Edite `firebase-config.js` com os seus dados reais.
5. Publique os ficheiros no Netlify.

## Regra do site

Se `firebase-config.js` estiver preenchido corretamente, o site usa Firebase.
Se não estiver, ele entra em modo local com `localStorage`.

## Regras de segurança recomendadas para teste

Use autenticação restrita mais tarde. Para um teste inicial controlado, pode usar regras temporárias apenas durante a configuração.

## Observação importante

O Firebase aqui foi implementado com **Realtime Database**, porque a estrutura atual do bolão funciona muito bem com um estado central simples.
