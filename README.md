# Teste de carga (k6): compra simultânea

Script adaptado do exemplo do professor. Em vez de `venda`/`produto`, ele exercita o nosso fluxo
completo pelo gateway: **fila → sacola (reserva atômica) → pedido → confirmação**, com a
saga rodando por mensagens no RabbitMQ.

O que ele faz:

1. `setup`: cria um evento com `ESTOQUE` ingressos e `COMPRADORES` usuários (um por comprador virtual).
2. Todos os compradores entram na fila ao mesmo tempo (a fila libera só 2 por vez), reservam 1 ingresso,
   confirmam a compra (não há pagamento) e acompanham o pedido até o estado final.
3. `teardown`: confere o estoque no banco e apaga os usuários de teste.

## Como rodar

Suba os serviços (login, gateway, estoque, fila, pedido) e instale o k6
(https://grafana.com/docs/k6/latest/set-up/install-k6/). Depois:

```bash
k6 run -e ADMIN_SENHA=<senha do admin> testes-carga/compra-simultanea.js
```

Parâmetros (`-e NOME=valor`): `COMPRADORES` (30), `ESTOQUE` (20), `GATEWAY` (http://localhost:8080),
`ADMIN_EMAIL`, `ESPERA_FILA_S` (240).

## Resultado esperado

| Métrica | Valor esperado |
|---|---|
| `vendas_pagas` | `min(ESTOQUE, COMPRADORES)` |
| `vendas_esgotadas` | `COMPRADORES - ESTOQUE` |
| `vendas_timeout` | 0 |
| estoque final | vendido = ESTOQUE, reservado = 0, disponível = 0 (nunca negativo) |

O evento criado (`CARGA ...`) fica no Atlas, porque evento com vendas não pode ser excluído.
