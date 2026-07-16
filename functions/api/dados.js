// Cloudflare Pages Function
// Rota: /api/dados
//
// Objetivo: servir o CSV da planilha pública do Google Sheets para o navegador,
// sem que o cliente precise acessar o Google diretamente. Isso elimina a maioria
// dos bloqueios corporativos (firewall/proxy) que impedem a leitura do Sheets.
//
// Estratégia de resiliência:
// - Timeout de 10s na requisição ao Google.
// - Retry com backoff (espera crescente entre tentativas).
// - Cache via Cache API do Cloudflare (caches.default).
// - Fallback: se o Google falhar, serve a última versão válida em cache,
//   mesmo que esteja expirada (stale-if-error).
// - Validação básica do CSV antes de gravar no cache, para nunca sobrescrever
//   um cache válido com uma resposta inválida (ex.: página de erro).

const GOOGLE_SHEETS_CSV_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vTcHCtfERtEop0Wzam17J0jOJLPPAon4bht0B55jnVcSBzid1c6eJoePUC2AAHcTOuVn8bujSfGaLic/pub?gid=972326270&single=true&output=csv';

const REQUEST_TIMEOUT_MS = 10000;
const MAX_TENTATIVAS = 3;
const CACHE_TTL_SEGUNDOS = 10 * 60; // 10 minutos

// Cabeçalhos esperados no CSV. Usados apenas para validação básica.
const CABECALHOS_ESPERADOS = ['PEDIDO', 'OC CLIENTE'];

// Cria um AbortController com timeout para a requisição fetch.
function comTimeout(ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { controller, timer };
}

// Valida se o conteúdo recebido parece um CSV válido.
// Não analisa todo o arquivo, apenas o essencial para evitar cache de lixo.
function csvEhValido(texto) {
    if (!texto || texto.trim().length === 0) {
        return false;
    }

    const primeiraLinha = texto.split('\n')[0] || '';
    const cabecalhos = primeiraLinha.split(',').map((h) => h.trim().toUpperCase());

    // Exige pelo menos os cabeçalhos mínimos esperados.
    const temTodos = CABECALHOS_ESPERADOS.every((h) => cabecalhos.includes(h));
    if (!temTodos) {
        return false;
    }

    // Exige mais de uma linha (cabeçalho + ao menos 1 registro).
    const linhas = texto.split('\n').filter((l) => l.trim().length > 0);
    return linhas.length > 1;
}

// Tenta buscar o CSV do Google com timeout e retry com backoff.
async function buscarCsvDoGoogle() {
    let ultimoErro = null;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa += 1) {
        const { controller, timer } = comTimeout(REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(GOOGLE_SHEETS_CSV_URL, {
                signal: controller.signal,
                headers: { 'Cache-Control': 'no-store' },
            });

            clearTimeout(timer);

            if (!response.ok) {
                ultimoErro = new Error(`Google respondeu ${response.status}`);
                // Se for erro claro do Google, não adianta retry imediato em 4xx.
                if (response.status >= 400 && response.status < 500) {
                    throw ultimoErro;
                }
            } else {
                const texto = await response.text();
                if (!csvEhValido(texto)) {
                    throw new Error('Conteúdo recebido não é um CSV válido');
                }
                return texto;
            }
        } catch (error) {
            clearTimeout(timer);
            ultimoErro = error;
            // AbortError indica timeout.
            const isTimeout = error.name === 'AbortError';
            if (tentativa < MAX_TENTATIVAS) {
                // Backoff: espera 500ms, 1000ms, ...
                const espera = 500 * tentativa;
                await new Promise((resolve) => setTimeout(resolve, espera));
                continue;
            }
            throw isTimeout ? new Error('Timeout ao acessar o Google Sheets') : ultimoErro;
        }
    }

    throw ultimoErro || new Error('Falha desconhecida ao buscar o Google Sheets');
}

export async function onRequest(context) {
    const cache = caches.default;

    try {
        // Tenta obter dados frescos do Google.
        const csvText = await buscarCsvDoGoogle();

        // Sucesso: grava no cache para uso futuro (fallback).
        const responseCache = new Response(csvText, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Cache-Control': `public, max-age=${CACHE_TTL_SEGUNDOS}, s-maxage=${CACHE_TTL_SEGUNDOS}`,
                'X-Source': 'Cloudflare Pages Function',
                'X-Google-Status': 'OK',
                'X-Cache-Time': new Date().toISOString(),
            },
        });

        // Clona para não consumir o body ao armazenar no cache.
        // Usa a própria requisição recebida como chave de cache.
        await cache.put(context.request, responseCache.clone());

        return responseCache;
    } catch (error) {
        // Falha ao acessar o Google: tenta servir o último cache válido.
        const cached = await cache.match(new Request('/api/dados'));
        if (cached) {
            const body = await cached.text();
            return new Response(body, {
                status: 200,
                headers: {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Cache-Control': `public, max-age=${CACHE_TTL_SEGUNDOS}, s-maxage=${CACHE_TTL_SEGUNDOS}`,
                    'X-Source': 'Cloudflare Pages Function',
                    'X-Google-Status': 'FALLBACK',
                    'X-Cache-Time': new Date().toISOString(),
                    'X-Error': encodeURIComponent(error.message || 'erro'),
                },
            });
        }

        // Sem cache disponível: retorna erro em texto simples (nunca HTML).
        return new Response(`Erro ao obter dados: ${error.message || 'falha'}`, {
            status: 502,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'X-Source': 'Cloudflare Pages Function',
                'X-Google-Status': 'ERROR',
            },
        });
    }
}
