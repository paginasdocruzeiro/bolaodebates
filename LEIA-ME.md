# Atualização completa do Bolão do Cruzeiro

Pacote preparado a partir da versão publicada em 12/07/2026.

## Como publicar

No GitHub, substitua os arquivos existentes:

- `app.js`
- `index.html`
- `styles.css`
- `sw.js`
- `firebase-config.js`
- `manifest.json`

Crie também estes dois arquivos novos na raiz do repositório:

- `enhancements.js`
- `enhancements.css`

Não é necessário mudar as regras do Firebase para esta atualização. O registro administrativo usa a permissão de administrador já aplicada ao caminho `state`.

## Melhorias incluídas

- central de notificações e resumo pessoal;
- conquistas e títulos;
- perfil completo de cada participante;
- gráfico de evolução da classificação;
- simulador de ranking por placar;
- backup e restauração JSON;
- registro de alterações administrativas;
- pré-visualização e confirmação de resultados;
- participantes ativos/inativos, redefinição de PIN e última aposta;
- palpites dos outros ocultos até o encerramento;
- confirmação compartilhável do palpite;
- tema claro e escuro;
- melhorias de teclado, contraste, leitor de tela e redução de movimento;
- aviso de nova versão da PWA;
- correção da tentativa de gravação automática por visitantes.

O cache da PWA foi atualizado para `bolao-v20`. Após publicar, usuários com a versão anterior podem precisar atualizar a página uma vez.
