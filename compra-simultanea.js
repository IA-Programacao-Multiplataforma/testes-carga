import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const GATEWAY = __ENV.GATEWAY || 'http://localhost:8080'
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'isaanine@gmail.com'
const ADMIN_SENHA = __ENV.ADMIN_SENHA || ''
const COMPRADORES = Number(__ENV.COMPRADORES || 30)
const ESTOQUE = Number(__ENV.ESTOQUE || 20)
const PRECO = Number(__ENV.PRECO || 100)

const ESPERA_FILA_S = Number(__ENV.ESPERA_FILA_S || 240)
const POLL_INTERVALO = Number(__ENV.POLL_INTERVALO || 2)
const POLL_PEDIDO_TENTATIVAS = Number(__ENV.POLL_PEDIDO_TENTATIVAS || 60)

const pagas = new Counter('vendas_pagas')
const esgotadas = new Counter('vendas_esgotadas')
const recusadas = new Counter('vendas_recusadas')
const canceladas = new Counter('vendas_canceladas')
const timeouts = new Counter('vendas_timeout')
const erros = new Counter('erro_inesperado')
const tempoDeCompra = new Trend('tempo_de_compra_ms', true)

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const auth = (token) => ({ headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` } })

export const options = {
  setupTimeout: '180s',
  teardownTimeout: '120s',
  scenarios: {
    compra_simultanea: {
      executor: 'per-vu-iterations',
      vus: COMPRADORES,
      iterations: 1,
      maxDuration: '8m',
    },
  },
}

export function setup() {
  if (!ADMIN_SENHA) {
    throw new Error('Informe a senha do admin: k6 run -e ADMIN_SENHA=... testes-carga/compra-simultanea.js')
  }

  const login = http.post(`${GATEWAY}/login/autenticacao/v1/login`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_SENHA }), { headers: JSON_HEADERS })
  const admin = login.json('token')
  if (!admin) throw new Error(`Login do admin falhou (${login.status})`)

  const criado = http.post(`${GATEWAY}/estoque/eventos`, JSON.stringify({
    titulo: `CARGA ${Date.now()}`,
    categoria: 'MUSICA',
    local: 'Arena de teste',
    cidade: 'SP',
    sessoes: [{
      dataEvento: '2027-12-31T20:00:00',
      inicioVenda: '2020-01-01T10:00:00',
      setores: [{ nome: 'Pista', preco: PRECO, capacidade: ESTOQUE }],
    }],
  }), auth(admin))
  if (criado.status !== 201 && criado.status !== 200) throw new Error(`Criar evento falhou (${criado.status}): ${criado.body}`)

  const evento = criado.json()
  const sessao = evento.sessoes[0]

  const execucao = Date.now()
  const cadastros = http.batch(Array.from({ length: COMPRADORES }, (_, i) => ({
    method: 'POST',
    url: `${GATEWAY}/login/autenticacao/v1/create`,
    body: JSON.stringify({
      username: `carga${execucao}x${i}`,
      email: `carga${execucao}x${i}@teste.com`,
      password: 'abc12345',
      cep: '01001000',
    }),
    params: { headers: JSON_HEADERS },
  })))
  const tokens = cadastros.map((r) => r.json('token'))
  if (tokens.some((t) => !t)) throw new Error('Algum cadastro de comprador falhou')

  const perfis = http.batch(tokens.map((t) => ({ method: 'GET', url: `${GATEWAY}/login/autenticacao/v1/me`, params: auth(t) })))
  const compradores = tokens.map((token, i) => ({ token, id: perfis[i].json('id') }))

  return { admin, eventoId: evento.id, sessaoId: sessao.id, setorId: sessao.setores[0].id, compradores }
}

export default function (data) {
  const comprador = data.compradores[__VU - 1]
  const inicio = Date.now()
  const p = auth(comprador.token)

  const entrada = http.post(`${GATEWAY}/fila/sessoes/${data.sessaoId}/entrar`, null, p)
  if (!check(entrada, { 'entrou na fila (2xx)': (r) => r.status >= 200 && r.status < 300 })) {
    erros.add(1)
    return
  }

  let ativo = false
  for (let i = 0; i < ESPERA_FILA_S / POLL_INTERVALO; i++) {
    const r = http.get(`${GATEWAY}/fila/sessoes/${data.sessaoId}/status`, p)
    if (r.status === 200) {
      if (r.json('status') === 'ATIVO') {
        ativo = true
        break
      }
      if (r.json('esgotado') === true) {
        esgotadas.add(1)
        http.del(`${GATEWAY}/fila/sessoes/${data.sessaoId}/sair`, null, p)
        return
      }
    }
    sleep(POLL_INTERVALO)
  }
  if (!ativo) {
    timeouts.add(1)
    return
  }

  const sacola = http.post(`${GATEWAY}/fila/sessoes/${data.sessaoId}/sacola`,
    JSON.stringify({ itens: [{ setorId: data.setorId, quantidade: 1 }] }), p)
  if (sacola.status === 409) {
    esgotadas.add(1)
    http.del(`${GATEWAY}/fila/sessoes/${data.sessaoId}/sair`, null, p) // libera a vaga para o próximo
    return
  }
  if (!check(sacola, { 'sacola montada (2xx)': (r) => r.status >= 200 && r.status < 300 })) {
    erros.add(1)
    return
  }

  const chave = `carga-${__VU}-${Date.now()}`
  const pedido = http.post(`${GATEWAY}/pedido/pedidos`, JSON.stringify({
    sessaoId: data.sessaoId,
  }), { headers: { ...JSON_HEADERS, Authorization: `Bearer ${comprador.token}`, 'Idempotency-Key': chave } })
  if (!check(pedido, { 'pedido aceito (202)': (r) => r.status === 202 })) {
    console.error(`Pedido recusado (${pedido.status}): ${pedido.body}`)
    erros.add(1)
    return
  }
  const pedidoId = pedido.json('pedidoId')

  let final = null
  for (let i = 0; i < POLL_PEDIDO_TENTATIVAS; i++) {
    sleep(POLL_INTERVALO)
    const r = http.get(`${GATEWAY}/pedido/pedidos/${pedidoId}`, p)
    if (r.status !== 200) continue
    const status = r.json('status')
    if (status === 'PAGO' || status === 'RECUSADO' || status === 'CANCELADO') {
      final = status
      break
    }
  }

  if (final === 'PAGO') {
    pagas.add(1)
    tempoDeCompra.add(Date.now() - inicio)
  } else if (final === 'RECUSADO') recusadas.add(1)
  else if (final === 'CANCELADO') canceladas.add(1)
  else timeouts.add(1)
}

export function teardown(data) {
  const resposta = http.get(`${GATEWAY}/estoque/eventos/${data.eventoId}`, { ...auth(data.admin), timeout: '60s' })
  const evento = resposta.json()
  const setor = evento.sessoes[0].setores[0]
  const esperadoVendido = Math.min(ESTOQUE, COMPRADORES)

  console.log('====================================')
  console.log(`Compradores simultâneos: ${COMPRADORES}   Estoque inicial: ${ESTOQUE}`)
  console.log(`Estoque final -> capacidade ${setor.capacidade}, vendido ${setor.vendido}, reservado ${setor.reservado}, disponível ${setor.disponivel}`)
  console.log('Confira nas métricas finais do k6:')
  console.log(`  vendas_pagas     -> deve ser ${esperadoVendido}`)
  console.log(`  vendas_esgotadas -> deve ser ${Math.max(0, COMPRADORES - ESTOQUE)}`)
  console.log('  vendas_timeout   -> deve ser 0 (se não for, aumente ESPERA_FILA_S)')
  console.log('====================================')

  if (setor.disponivel < 0 || setor.vendido > ESTOQUE) {
    console.error('FALHA: houve venda em excesso (overselling): a reserva não protege contra concorrência.')
  } else if (setor.vendido !== esperadoVendido || setor.reservado !== 0) {
    console.error(`ATENÇÃO: esperado vendido=${esperadoVendido} e reservado=0. Investigar.`)
  } else {
    console.log('Estoque final bateu com o esperado: nenhum ingresso vendido a mais.')
  }

  http.batch(data.compradores.map((c) => ({
    method: 'DELETE', url: `${GATEWAY}/login/usuarios/${c.id}`, params: auth(c.token),
  })))
}
