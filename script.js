const CSV_URL_BASE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTcHCtfERtEop0Wzam17J0jOJLPPAon4bht0B55jnVcSBzid1c6eJoePUC2AAHcTOuVn8bujSfGaLic/pub?gid=972326270&single=true&output=csv';
let dadosDoSistema = [];
let carregamentoPromise = null;
let ultimaAtualizacao = null;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_STORAGE_KEY = 'gp_planilha_cache_v1';
const MAX_TENTATIVAS = 3;
const INTERVALO_ATUALIZACAO_MS = 10 * 60 * 1000;
let avisoCacheAtivo = false;

const MSG_NAO_ENCONTRADO = 'Pedido em preparação. Assim que for despachado, você receberá automaticamente um e-mail com as informações de rastreamento. Caso seja necessário, solicite nosso suporte, abrindo um ticket.';

document.addEventListener('DOMContentLoaded', () => {
    const inputBusca = document.getElementById('numeroBusca');
    const btnBuscar = document.getElementById('btnBuscar');
    const btnRastreio = document.getElementById('btnRastreio');

    if (inputBusca) {
        inputBusca.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                buscarDados();
            }
        });
    }

    if (btnBuscar) {
        btnBuscar.addEventListener('click', buscarDados);
    }

    if (btnRastreio) {
        btnRastreio.addEventListener('click', redirecionar);
    }

    carregarDadosIniciais().catch((error) => {
        console.error('Erro ao sincronizar dados:', error);
    });

    setInterval(() => {
        carregarDadosIniciais(true)
            .then(() => {
                avisoCacheAtivo = false;
                removerAvisoCache();
            })
            .catch((error) => {
                console.warn('Atualização em segundo plano falhou:', error);
            });
    }, INTERVALO_ATUALIZACAO_MS);
});

function exibirAvisoCache() {
    const resultadosDiv = document.getElementById('resultados');
    if (!resultadosDiv || avisoCacheAtivo) {
        return;
    }
    avisoCacheAtivo = true;
    const aviso = document.createElement('div');
    aviso.id = 'avisoCache';
    aviso.className = 'cache-warning';
    aviso.textContent = 'Exibindo dados da última sincronização bem-sucedida. Podem estar desatualizados.';
    resultadosDiv.prepend(aviso);
}

function removerAvisoCache() {
    const aviso = document.getElementById('avisoCache');
    if (aviso) {
        aviso.remove();
    }
    avisoCacheAtivo = false;
}

function parseCsv(texto) {
    const linhas = [];
    let linhaAtual = [];
    let valorAtual = '';
    let dentroDeAspas = false;

    for (let i = 0; i < texto.length; i += 1) {
        const caractere = texto[i];

        if (caractere === '"') {
            if (dentroDeAspas && texto[i + 1] === '"') {
                valorAtual += '"';
                i += 1;
            } else {
                dentroDeAspas = !dentroDeAspas;
            }
        } else if (caractere === ',' && !dentroDeAspas) {
            linhaAtual.push(valorAtual.trim());
            valorAtual = '';
        } else if ((caractere === '\n' || caractere === '\r') && !dentroDeAspas) {
            if (caractere === '\r' && texto[i + 1] === '\n') {
                i += 1;
            }
            linhaAtual.push(valorAtual.trim());
            if (linhaAtual.some((campo) => campo.length > 0)) {
                linhas.push(linhaAtual);
            }
            linhaAtual = [];
            valorAtual = '';
        } else {
            valorAtual += caractere;
        }
    }

    if (valorAtual.length > 0 || linhaAtual.length > 0) {
        linhaAtual.push(valorAtual.trim());
        if (linhaAtual.some((campo) => campo.length > 0)) {
            linhas.push(linhaAtual);
        }
    }

    return linhas;
}

function normalizarTexto(valor) {
    return String(valor ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function salvarCache(csvText) {
    try {
        const payload = { texto: csvText, ts: Date.now() };
        localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        console.warn('Não foi possível salvar o cache local:', e);
    }
}

function lerCache() {
    try {
        const raw = localStorage.getItem(CACHE_STORAGE_KEY);
        if (!raw) return null;
        const payload = JSON.parse(raw);
        if (!payload || typeof payload.texto !== 'string') return null;
        return payload;
    } catch (e) {
        console.warn('Cache local corrompido, ignorando:', e);
        return null;
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buscarCsvComRetry(url) {
    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa += 1) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return await response.text();
            }
            ultimoErro = new Error(`Falha ao buscar dados: ${response.status}`);
            if (response.status === 429 || response.status >= 500) {
                const espera = 1000 * tentativa;
                console.warn(`Tentativa ${tentativa} falhou (${response.status}). Aguardando ${espera}ms...`);
                await delay(espera);
                continue;
            }
            throw ultimoErro;
        } catch (error) {
            ultimoErro = error;
            if (tentativa < MAX_TENTATIVAS) {
                const espera = 1000 * tentativa;
                console.warn(`Tentativa ${tentativa} falhou (${error.message}). Aguardando ${espera}ms...`);
                await delay(espera);
            }
        }
    }
    throw ultimoErro || new Error('Falha desconhecida ao buscar dados');
}

async function carregarDadosIniciais(force = false) {
    if (!force && dadosDoSistema.length > 0 && ultimaAtualizacao && Date.now() - ultimaAtualizacao < CACHE_TTL_MS) {
        return dadosDoSistema;
    }

    if (carregamentoPromise) {
        return carregamentoPromise;
    }

    carregamentoPromise = (async () => {
        const ver = new Date().getTime();
        let csvText;
        try {
            csvText = await buscarCsvComRetry(`${CSV_URL_BASE}&v=${ver}`);
        } catch (erroRede) {
            const cache = lerCache();
            if (cache && cache.texto) {
                console.warn('Falha ao buscar dados ao vivo. Usando cache local salvo.', erroRede);
                csvText = cache.texto;
                avisoCacheAtivo = true;
            } else {
                throw erroRede;
            }
        }

        const linhas = parseCsv(csvText);

        if (linhas.length === 0) {
            throw new Error('CSV vazio');
        }

        const cabecalhos = linhas[0].map((header) => header.trim());
        dadosDoSistema = linhas.slice(1).map((linha) => {
            const objeto = {};
            cabecalhos.forEach((cabecalho, indice) => {
                objeto[cabecalho] = linha[indice] ? linha[indice].trim() : '';
            });
            return objeto;
        });

        if (!avisoCacheAtivo) {
            salvarCache(csvText);
        }
        ultimaAtualizacao = Date.now();
        return dadosDoSistema;
    })();

    try {
        return await carregamentoPromise;
    } finally {
        carregamentoPromise = null;
    }
}

function definirEstadoCarregamento(isLoading) {
    const btn = document.getElementById('btnBuscar');
    if (!btn) {
        return;
    }

    const textoOriginal = btn.dataset.originalText || 'Buscar informações';
    btn.disabled = isLoading;
    btn.textContent = isLoading ? 'Buscando...' : textoOriginal;
}

function renderizarResultados(resultados) {
    const resultadosDiv = document.getElementById('resultados');
    if (!resultadosDiv) {
        return;
    }

    resultadosDiv.innerHTML = '';

    if (resultados.length === 0) {
        const mensagem = document.createElement('div');
        mensagem.className = 'error-msg';
        mensagem.textContent = MSG_NAO_ENCONTRADO;
        resultadosDiv.appendChild(mensagem);
        return;
    }

    const selectTransp = document.getElementById('transportadora');
    const transportePrincipal = resultados[0]['TRANSPORTADORA'] || '';

    if (selectTransp) {
        for (let index = 0; index < selectTransp.options.length; index += 1) {
            if (selectTransp.options[index].text.toUpperCase().includes(transportePrincipal.toUpperCase())) {
                selectTransp.selectedIndex = index;
                break;
            }
        }
    }

    resultados.forEach((res, index) => {
        const codigo = res['CODIGO DE RASTREIO'] || 'Pendente';
        const dataEntrega = res['DATA ENTREGA'] || '';
        let statusTexto = 'Pedido enviado';
        let statusClasse = 'enviado';

        if (dataEntrega) {
            if (dataEntrega.toUpperCase() === 'SEM SUCESSO') {
                statusTexto = 'Falha na entrega';
                statusClasse = 'falha';
            } else {
                statusTexto = `Entregue em ${dataEntrega}`;
                statusClasse = 'entregue';
            }
        }

        const card = document.createElement('div');
        card.className = `result-card ${statusClasse}`;

        const linha1 = document.createElement('div');
        linha1.className = 'line-1';
        const registro = document.createElement('span');
        registro.textContent = `REGISTRO DE ENVIO #${index + 1}`;
        const chipStatus = document.createElement('span');
        chipStatus.className = 'status-chip';
        chipStatus.textContent = statusTexto;
        linha1.append(registro, chipStatus);

        const divider = document.createElement('div');
        divider.className = 'divider';

        const linha2 = document.createElement('div');
        linha2.className = 'line-2';
        const chips = [
            ['NF', res['NOTA FISCAL']],
            ['Pedido', res['PEDIDO']],
            ['OC', res['OC CLIENTE']]
        ];

        chips.forEach(([label, valor]) => {
            const chip = document.createElement('span');
            chip.className = 'data-chip';
            chip.textContent = `${label}: ${valor}`;
            linha2.appendChild(chip);
        });

        const linha3Transp = document.createElement('div');
        linha3Transp.className = 'line-3-transp';
        linha3Transp.textContent = `Transportadora: ${res['TRANSPORTADORA']}`;

        const linha3Dest = document.createElement('div');
        linha3Dest.className = 'line-3-dest';
        linha3Dest.textContent = `Destino: ${res['CIDADE DESTINO']}`;

        const linha4 = document.createElement('div');
        linha4.className = 'line-4';
        linha4.textContent = `Dados de rastreio: ${codigo}`;

        card.append(linha1, divider, linha2, linha3Transp, linha3Dest, linha4);
        resultadosDiv.appendChild(card);
    });
}

async function buscarDados() {
    const inputBusca = document.getElementById('numeroBusca');
    const termoBusca = inputBusca ? inputBusca.value.trim() : '';
    const resultadosDiv = document.getElementById('resultados');

    if (!termoBusca) {
        if (resultadosDiv) {
            resultadosDiv.innerHTML = '<div class="empty-state">Informe o número do pedido ou OC.</div>';
        }
        return;
    }

    const btn = document.getElementById('btnBuscar');
    if (btn && !btn.dataset.originalText) {
        btn.dataset.originalText = btn.textContent;
    }

    definirEstadoCarregamento(true);

    try {
        await carregarDadosIniciais();
        if (avisoCacheAtivo) {
            exibirAvisoCache();
        } else {
            removerAvisoCache();
        }
        const termoNormalizado = normalizarTexto(termoBusca);
        const resultados = dadosDoSistema.filter((item) => {
            const pedido = normalizarTexto(item['PEDIDO']);
            const oc = normalizarTexto(item['OC CLIENTE']);
            return pedido === termoNormalizado || oc === termoNormalizado;
        });

        renderizarResultados(resultados);
    } catch (error) {
        console.error('Erro ao carregar dados:', error);
        if (resultadosDiv) {
            resultadosDiv.innerHTML = '<div class="error-msg">Erro ao conectar com o servidor. Tente novamente.</div>';
        }
    } finally {
        definirEstadoCarregamento(false);
    }
}

function redirecionar() {
    const selectTransportadora = document.getElementById('transportadora');
    if (!selectTransportadora) {
        return;
    }

    window.open(selectTransportadora.value, '_blank', 'noopener,noreferrer');
}