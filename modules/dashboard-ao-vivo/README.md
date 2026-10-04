# Dashboard Ao Vivo — módulo independente

## Atualização
- Automática: a cada 30 minutos.
- Manual: botão `Atualizar agora`.

## Otimização de recursos
- Primeira abertura: carrega o mês corrente uma única vez.
- Atualizações automáticas seguintes: consultam somente o dia atual.
- Dias anteriores permanecem em cache local durante a sessão.
- Alternar Hoje/Mês, Empresa, Unidade e Indicador não consulta o banco novamente.
- `Atualizar agora` força sincronização completa do mês.
- Cadastros de empresas/unidades/perfis são reaproveitados por até 30 minutos.
- Ao sair do módulo, o polling é pausado.
- Se a aba do navegador ficar em segundo plano, o polling é pausado.
- Ao retornar à aba, atualiza somente o dia atual.

## Manutenção
- `index.html`: visual/animações.
- `bridge.js`: banco, cache e integração.

Não requer SQL novo.


## Horário oficial
Todos os horários exibidos neste módulo usam São Paulo/Brasília (`America/Sao_Paulo`).
