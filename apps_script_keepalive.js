// ============================================================
// KEEP-ALIVE DA PLANILHA (Google Apps Script)
// ============================================================
// Objetivo: manter o CSV publicado "quente" para que, mesmo
// depois de horas sem abrir a planilha, o sistema do cliente
// consiga puxar os dados sem erro de endpoint frio.
//
// COMO INSTALAR:
// 1. Abra sua planilha no Google Sheets.
// 2. Menu: Extensões > Apps Script.
// 3. Apague o conteúdo e cole este código.
// 4. Substitua CSV_PUBLICADO_URL pela URL de "Publicar na web"
//    (a mesma base usada no script.js, SEM o &v=).
// 5. Salve (Ctrl+S).
// 6. No editor, execute uma vez a função configurarGatilho()
//    (autorize quando solicitado).
// 7. Pronto: a cada 60 min o script busca o CSV publicado,
//    mantendo o cache de borda do Google fresco.
// ============================================================

const CSV_PUBLICADO_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTcHCtfERtEop0Wzam17J0jOJLPPAon4bht0B55jnVcSBzid1c6eJoePUC2AAHcTOuVn8bujSfGaLic/pub?gid=972326270&single=true&output=csv';

function manterPlanilhaQuente() {
  try {
    // IMPORTANTE: o cliente (script.js) busca com &v=timestamp para
    // evitar cache do navegador. Para aquecer exatamente o mesmo
    // recurso, usamos o mesmo padrão de URL aqui.
    const url = `${CSV_PUBLICADO_URL}&v=${new Date().getTime()}`;
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true
    });
    console.log('Keep-alive OK - status:', response.getResponseCode());
  } catch (e) {
    console.warn('Keep-alive falhou:', e);
  }
}

function configurarGatilho() {
  // Remove gatilhos antigos para evitar duplicação
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'manterPlanilhaQuente') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Dispara a cada 60 minutos (configurado pelo usuário)
  ScriptApp.newTrigger('manterPlanilhaQuente')
    .timeBased()
    .everyHours(1)
    .create();

  console.log('Gatilho de keep-alive configurado (a cada 60 min).');
}
