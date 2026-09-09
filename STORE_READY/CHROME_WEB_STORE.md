# Chrome Web Store — v5.6

## Finalidade única
Permitir que o usuário acompanhe e analise mudanças observadas na sua própria rede do Instagram ao longo do tempo.

## Descrição curta
Acompanhe seguidores, seguindo, mudanças entre coletas, histórico e analytics da sua própria conta do Instagram.

## Permissões
- `storage`: sessão, preferências, cache/snapshots e estado necessário aos históricos/diffs.
- `https://www.instagram.com/*`: painel e consultas da própria conta autenticada.
- `https://*.supabase.co/*`: autenticação, sincronização, planos/limites e backend.

## Antes de enviar
1. Substitua os placeholders da política de privacidade.
2. Publique `web/privacy.html` numa URL HTTPS pública.
3. Use essa URL no campo Privacy Policy.
4. Informe que existem recursos pagos.
5. Faça screenshots reais e legíveis da v5.6.
6. Rode `bash scripts/build-chrome-store.sh`.
7. Teste o ZIP antes do upload.
