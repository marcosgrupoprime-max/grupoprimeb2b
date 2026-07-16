const CSV_URL_BASE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTcHCtfERtEop0Wzam17J0jOJLPPAon4bht0B55jnVcSBzid1c6eJoePUC2AAHcTOuVn8bujSfGaLic/pub?gid=972326270&single=true&output=csv';
let dadosDoSistema = [];
let carregamentoPromise = null;
const MAX_TENTATIVAS = 3;
const INTERVALO_ATUALIZACAO_MS = 10 * 60 * 1000;

const MSG_NAO_ENCONTRADO = 'Pedido em preparação. Assim que for despachado, você receberá automaticamente um e-mail com as informações de rastreamento. Caso seja necessário, solicite nosso suporte, abrindo um <a href="https://grupoprimeb2b.com.br/ticket/" target="_blank" rel="noopener noreferrer" class="ticket-link">ticket</a>.';

// Configuração de transportadoras carregada de transportadoras.json
let CONFIG_TRANSPORTADORAS = { categorias: {}, transportadoras: [] };

function obterUrlTransportadora(nome, codigoRastreio) {
    if (!nome) {
        return '';
    }
    const chave = normalizarTexto(nome);
    const transp = CONFIG_TRANSPORTADORAS.transportadoras.find((t) => normalizarTexto(t.nome) === chave);
    if (!transp) {
        return '';
    }

    const cat = CONFIG_TRANSPORTADORAS.categorias[transp.categoria];
    if (!cat) {
        return '';
    }

    switch (cat.tipo) {
        case 'ssw': {
            // Formato do campo: "Remetente: CNPJ - NF: NUMERO"
            const cnpj = (codigoRastreio.match(/Remetente:\s*([\d./-]+)/) || [])[1] || '';
            const nf = (codigoRastreio.match(/NF:\s*([\d./-]+)/) || [])[1] || '';
            if (!cnpj || !nf) {
                return '';
            }
            return cat.urlModelo.replace('{CNPJ}', cnpj).replace('{NF}', nf);
        }
        case 'freteclick':
            return cat.url;
        case 'formato': {
            const cnpj = (codigoRastreio.match(/Remetente:\s*([\d./-]+)/) || [])[1] || '';
            const nf = (codigoRastreio.match(/NF:\s*([\d./-]+)/) || [])[1] || '';
            if (!cnpj || !nf) {
                return '';
            }
            return cat.urlModelo.replace('{CNPJ}', cnpj).replace('{NF}', nf);
        }
        case 'correios': {
            const rastreio = (codigoRastreio || '').trim();
            if (!rastreio) {
                return '';
            }
            return cat.urlModelo.replace('{RASTREIO}', encodeURIComponent(rastreio));
        }
        case 'siteproprio':
            return transp.url || '';
        default:
            return '';
    }
}

// Sistema de logs para diagnóstico
const logs = [];
function adicionarLog(tipo, mensagem) {
    const timestamp = new Date().toLocaleTimeString();
    logs.push({ tipo, mensagem, timestamp });
    console.log(`[${tipo}] ${mensagem}`);
}

function obterLogs() {
    return logs;
}

document.addEventListener('DOMContentLoaded', () => {
    const inputBusca = document.getElementById('numeroBusca');
    const btnBuscar = document.getElementById('btnBuscar');

    // Ícone de logs no rodapé
    const footer = document.querySelector('.main-footer');
    if (footer) {
        const logIcon = document.createElement('button');
        logIcon.id = 'btnLogs';
        logIcon.innerHTML = '🔍';
        logIcon.title = 'Ver logs de diagnóstico';
        logIcon.style.cssText = 'background:none;border:none;font-size:12px;cursor:pointer;opacity:0.5;padding:2px;';
        logIcon.addEventListener('click', abrirModalLogs);
        footer.appendChild(logIcon);
    }

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

    carregarConfigTransportadoras().catch((error) => {
        adicionarLog('ERRO', `Falha ao carregar transportadoras.json: ${error.message}`);
    });

    carregarDadosIniciais().catch((error) => {
        adicionarLog('ERRO', `Falha ao sincronizar dados: ${error.message}`);
    });

    setInterval(() => {
        carregarDadosIniciais(true)
            .then(() => {
                adicionarLog('INFO', 'Atualização em segundo plano concluída');
            })
            .catch((error) => {
                adicionarLog('ERRO', `Atualização em segundo plano falhou: ${error.message}`);
            });
    }, INTERVALO_ATUALIZACAO_MS);
});

function abrirModalLogs() {
    const modal = document.createElement('div');
    modal.id = 'modalLogs';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    
    const content = document.createElement('div');
    content.style.cssText = 'background:white;border-radius:8px;max-width:600px;width:100%;max-height:80vh;overflow:auto;padding:20px;';
    
    const titulo = document.createElement('h3');
    titulo.textContent = 'Logs de Diagnóstico';
    titulo.style.marginTop = '0';
    
    const lista = document.createElement('pre');
    lista.style.cssText = 'font-size:11px;text-align:left;white-space:pre-wrap;word-break:break-all;';
    lista.textContent = logs.map(l => `[${l.timestamp}] ${l.tipo}: ${l.mensagem}`).join('\n') || 'Nenhum log registrado';
    
    const fechar = document.createElement('button');
    fechar.textContent = 'Fechar';
    fechar.style.cssText = 'margin-top:15px;padding:8px 16px;';
    fechar.onclick = () => modal.remove();
    
    content.append(titulo, lista, fechar);
    modal.appendChild(content);
    document.body.appendChild(modal);
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

function escapeHtml(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buscarCsvComRetry(url) {
    adicionarLog('INFO', `Iniciando busca: ${url}`);
    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa += 1) {
        try {
            adicionarLog('DEBUG', `Tentativa ${tentativa} de ${MAX_TENTATIVAS}`);
            const response = await fetch(url, { mode: 'cors' });
            adicionarLog('DEBUG', `Response status: ${response.status} ${response.statusText}`);
            if (response.ok) {
                const text = await response.text();
                adicionarLog('SUCESSO', `Dados recebidos: ${text.length} bytes, ${text.split('\n').length} linhas`);
                return text;
            }
            ultimoErro = new Error(`Falha ao buscar dados: ${response.status} ${response.statusText}`);
            if (response.status === 429 || response.status >= 500) {
                const espera = 1000 * tentativa;
                adicionarLog('WARN', `Tentativa ${tentativa} falhou (${response.status}). Aguardando ${espera}ms...`);
                await delay(espera);
                continue;
            }
            throw ultimoErro;
        } catch (error) {
            // Captura detalhes de erro CORS/bloqueio de rede
            let errorMsg = error.message;
            if (error.name === 'TypeError' && !error.message.includes('status')) {
                errorMsg = `Bloqueio de rede/CORS: ${error.message}. Verifique conexão, proxy ou firewall.`;
            }
            adicionarLog('ERRO', `Tentativa ${tentativa} falhou: ${errorMsg}`);
            ultimoErro = error;
            if (tentativa < MAX_TENTATIVAS) {
                const espera = 1000 * tentativa;
                await delay(espera);
            }
        }
    }
    adicionarLog('ERRO', `Todas as tentativas falharam. Último erro: ${ultimoErro?.message}`);
    throw ultimoErro || new Error('Falha desconhecida ao buscar dados');
}

async function carregarConfigTransportadoras() {
    adicionarLog('INFO', 'Carregando transportadoras.json');
    const response = await fetch('transportadoras.json', { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Status ${response.status}`);
    }
    CONFIG_TRANSPORTADORAS = await response.json();
    adicionarLog('SUCESSO', `Config de transportadoras carregada: ${CONFIG_TRANSPORTADORAS.transportadoras.length} transportadoras`);
    return CONFIG_TRANSPORTADORAS;
}

async function carregarDadosIniciais(force = false) {
    adicionarLog('INFO', `carregarDadosIniciais chamado (force=${force})`);
    
    if (carregamentoPromise) {
        adicionarLog('DEBUG', 'Reutilizando promise existente');
        return carregamentoPromise;
    }

    carregamentoPromise = (async () => {
        const ver = new Date().getTime();
        const csvText = await buscarCsvComRetry(`${CSV_URL_BASE}&v=${ver}`);

        const linhas = parseCsv(csvText);
        adicionarLog('DEBUG', `CSV parseado: ${linhas.length} linhas`);

        if (linhas.length === 0) {
            throw new Error('CSV vazio - nenhuma linha encontrada');
        }

        const cabecalhos = linhas[0].map((header) => header.trim());
        adicionarLog('DEBUG', `Cabeçalhos: ${cabecalhos.join(', ')}`);
        
        dadosDoSistema = linhas.slice(1).map((linha) => {
            const objeto = {};
            cabecalhos.forEach((cabecalho, indice) => {
                objeto[cabecalho] = linha[indice] ? linha[indice].trim() : '';
            });
            return objeto;
        });
        
        adicionarLog('SUCESSO', `Dados carregados: ${dadosDoSistema.length} registros`);
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

function renderizarResultados(resultados, termosSemResultado = []) {
    const resultadosDiv = document.getElementById('resultados');
    if (!resultadosDiv) {
        return;
    }

    resultadosDiv.innerHTML = '';

    if (resultados.length === 0 && termosSemResultado.length === 0) {
        const mensagem = document.createElement('div');
        mensagem.className = 'error-msg';
        mensagem.innerHTML = MSG_NAO_ENCONTRADO;
        resultadosDiv.appendChild(mensagem);
        return;
    }

    resultados.forEach((res, index) => {
        const codigo = res['CODIGO DE RASTREIO'] || 'Pendente';
        const dataEntrega = res['DATA ENTREGA'] || '';
        let statusTexto = 'Pedido enviado';
        let statusClasse = 'enviado';
        let statusIcone = 'ti-truck-delivery';

        if (dataEntrega) {
            if (dataEntrega.toUpperCase() === 'SEM SUCESSO') {
                statusTexto = 'Falha na entrega';
                statusClasse = 'falha';
                statusIcone = 'ti-alert-triangle';
            } else {
                statusTexto = `Entregue em ${dataEntrega}`;
                statusClasse = 'entregue';
                statusIcone = 'ti-circle-check';
            }
        }

        const card = document.createElement('div');
        card.className = `result-card ${statusClasse}`;

        const linha1 = document.createElement('div');
        linha1.className = 'line-1';
        const registro = document.createElement('span');
        registro.className = 'line-1-label';
        registro.textContent = `Registro de envio #${index + 1}`;
        const chipStatus = document.createElement('span');
        chipStatus.className = 'status-chip';
        chipStatus.innerHTML = `<i class="ti ${statusIcone}" aria-hidden="true"></i><span>${escapeHtml(statusTexto)}</span>`;
        linha1.append(registro, chipStatus);

        const linha2 = document.createElement('div');
        linha2.className = 'line-2';
        const chips = [
            ['NF', res['NOTA FISCAL']],
            ['Pedido', res['PEDIDO']],
            ['OC', res['OC CLIENTE']]
        ];

        chips.forEach(([label, valor]) => {
            const chip = document.createElement('div');
            chip.className = 'data-chip';
            chip.innerHTML = `<span class="data-chip-label">${label}</span><span class="data-chip-value">${escapeHtml(valor)}</span>`;
            linha2.appendChild(chip);
        });

        const linha3Transp = document.createElement('div');
        linha3Transp.className = 'line-3-transp';
        linha3Transp.innerHTML = `<i class="ti ti-truck" aria-hidden="true"></i>Transportadora: <strong>${escapeHtml(res['TRANSPORTADORA'])}</strong>`;

        const linha3Dest = document.createElement('div');
        linha3Dest.className = 'line-3-dest';
        linha3Dest.innerHTML = `<i class="ti ti-map-pin" aria-hidden="true"></i>Destino: <strong>${escapeHtml(res['CIDADE DESTINO'])}</strong>`;

        const linha3Envio = document.createElement('div');
        linha3Envio.className = 'line-3-envio';
        linha3Envio.innerHTML = `<i class="ti ti-calendar" aria-hidden="true"></i>Data de envio: <strong>${escapeHtml(res['DATA DE COLETA'])}</strong>`;

        const linha4 = document.createElement('div');
        linha4.className = 'line-4';
        linha4.innerHTML = `<div class="line-4-label">Dados de rastreio</div><div class="line-4-value">${escapeHtml(codigo)}</div>`;

        const btnRastreio = document.createElement('a');
        btnRastreio.className = 'btn-track';
        btnRastreio.innerHTML = `<i class="ti ti-external-link" aria-hidden="true"></i>Buscar no site da transportadora`;
        const urlTransp = obterUrlTransportadora(res['TRANSPORTADORA'], codigo);
        if (urlTransp) {
            btnRastreio.href = urlTransp;
            btnRastreio.target = '_blank';
            btnRastreio.rel = 'noopener noreferrer';
        } else {
            btnRastreio.classList.add('disabled');
            btnRastreio.textContent = 'Rastreio indisponível para esta transportadora';
        }

        card.append(linha1, linha2, linha3Transp, linha3Dest, linha3Envio, linha4, btnRastreio);
        resultadosDiv.appendChild(card);
    });

    termosSemResultado.forEach((termo) => {
        const card = document.createElement('div');
        card.className = 'result-card nao-encontrado';

        const linha1 = document.createElement('div');
        linha1.className = 'line-1';
        const registro = document.createElement('span');
        registro.className = 'line-1-label';
        registro.textContent = `Busca: ${termo}`;
        linha1.append(registro);

        const msg = document.createElement('div');
        msg.className = 'nao-encontrado-msg';
        msg.innerHTML = MSG_NAO_ENCONTRADO;

        card.append(linha1, msg);
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

    // Divide a entrada em vários termos (espaço, vírgula ou ponto-e-vírgula)
    const termos = termoBusca.split(/[\s,;]+/).map((t) => t.trim()).filter((t) => t.length > 0);

    definirEstadoCarregamento(true);

    try {
        if (!CONFIG_TRANSPORTADORAS.transportadoras.length) {
            await carregarConfigTransportadoras();
        }
        await carregarDadosIniciais();
        adicionarLog('DEBUG', `Total de registros disponíveis: ${dadosDoSistema.length}`);

        const encontrados = [];
        const termosSemResultado = [];

        termos.forEach((termo) => {
            const termoNormalizado = normalizarTexto(termo);
            adicionarLog('DEBUG', `Buscando por: "${termo}" (normalizado: "${termoNormalizado}")`);

            const resultados = dadosDoSistema.filter((item) => {
                const pedido = normalizarTexto(item['PEDIDO']);
                const oc = normalizarTexto(item['OC CLIENTE']);
                return pedido === termoNormalizado || oc === termoNormalizado;
            });

            if (resultados.length > 0) {
                encontrados.push(...resultados);
            } else {
                termosSemResultado.push(termo);
            }
        });

        adicionarLog('DEBUG', `Total de envios encontrados: ${encontrados.length} | Termos sem resultado: ${termosSemResultado.length}`);

        renderizarResultados(encontrados, termosSemResultado);
    } catch (error) {
        adicionarLog('ERRO', `Erro ao carregar dados: ${error.message}`);
        if (resultadosDiv) {
            resultadosDiv.innerHTML = '<div class="error-msg">Erro ao conectar com o servidor. Tente novamente.</div>';
        }
    } finally {
        definirEstadoCarregamento(false);
    }
}

function redirecionar() {
    // Função mantida apenas como fallback; o rastreio agora é feito por card.
}