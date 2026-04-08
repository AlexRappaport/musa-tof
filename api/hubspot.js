// api/hubspot.js — Vercel Serverless Function

const PIPELINE_IDS = {
  'pre_vendas': '863330820',
  'smb':        '821308952',
  'enterprise': '795451392',
  'expansao':   '874756940',
  'rcc':        '885602211',
};
const ALL_PIPELINE_IDS = Object.values(PIPELINE_IDS);
const BACKLOG_STAGE  = 'backlog';
const ATIVADO_STAGES = ['contato_inicial','agendado','reuniao_diagnostico','concluido'];
const DEAL_PROPS = ['dealname','pipeline','dealstage','createdate','closedate','hs_lastmodifieddate','hubspot_owner_id','hub2_deal__canal_de_aquisicao','detalhamento_de_canal','segmento___ibge','hub2_deal__classificacao_do_lead','status_da_negociacao','amount'].join(',');

async function fetchAllDeals(token, filters = [], props = DEAL_PROPS) {
  let deals = [], after;
  do {
    const body = { filterGroups: filters.length ? [{ filters }] : [], properties: props.split(','), limit: 200, ...(after ? { after } : {}) };
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', { method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(body) });
    if (!res.ok) { const err = await res.text(); throw new Error(`HubSpot API error ${res.status}: ${err}`); }
    const data = await res.json();
    deals = deals.concat(data.results || []);
    after = data.paging?.next?.after;
  } while (after);
  return deals;
}

function getPeriodFilters(period) {
  const now = new Date();
  let curStart, curEnd, prevStart, prevEnd;
  switch (period) {
    case 'semana_atual': {
      const day = now.getDay();
      curStart = new Date(now); curStart.setDate(now.getDate() - (day === 0 ? 6 : day - 1)); curStart.setHours(0,0,0,0);
      curEnd = new Date();
      prevStart = new Date(curStart); prevStart.setDate(curStart.getDate() - 7);
      prevEnd = new Date(curStart); prevEnd.setMilliseconds(-1);
      break;
    }
    case 'semana_anterior': {
      const day = now.getDay();
      curStart = new Date(now); curStart.setDate(now.getDate() - (day === 0 ? 6 : day - 1) - 7); curStart.setHours(0,0,0,0);
      curEnd = new Date(curStart); curEnd.setDate(curStart.getDate() + 6); curEnd.setHours(23,59,59,999);
      prevStart = new Date(curStart); prevStart.setDate(curStart.getDate() - 7);
      prevEnd = new Date(curStart); prevEnd.setMilliseconds(-1);
      break;
    }
    case 'trimestre': {
      const q = Math.floor(now.getMonth() / 3);
      curStart = new Date(now.getFullYear(), q * 3, 1); curEnd = new Date();
      prevStart = new Date(now.getFullYear(), (q - 1) * 3, 1);
      prevEnd = new Date(curStart); prevEnd.setMilliseconds(-1);
      break;
    }
    case 'semestre': {
      const h = now.getMonth() < 6 ? 0 : 6;
      curStart = new Date(now.getFullYear(), h, 1); curEnd = new Date();
      prevStart = new Date(now.getFullYear() - (h === 0 ? 1 : 0), h === 0 ? 6 : 0, 1);
      prevEnd = new Date(curStart); prevEnd.setMilliseconds(-1);
      break;
    }
    default: { // mes_atual
      curStart = new Date(now.getFullYear(), now.getMonth(), 1); curEnd = new Date();
      prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      prevEnd = new Date(curStart); prevEnd.setMilliseconds(-1);
    }
  }
  const curFilter  = [{ propertyName:'createdate', operator:'GTE', value:curStart.getTime().toString() }, { propertyName:'createdate', operator:'LTE', value:curEnd.getTime().toString() }];
  const prevFilter = [{ propertyName:'createdate', operator:'GTE', value:prevStart.getTime().toString() }, { propertyName:'createdate', operator:'LTE', value:prevEnd.getTime().toString() }];
  return { curFilter, prevFilter };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return res.status(500).json({ error: 'HUBSPOT_API_KEY not configured' });
  const { endpoint, period = 'mes_atual', pipeline = 'todos' } = req.query;
  try {
    switch (endpoint) {
      case 'visao_geral': {
        const { curFilter, prevFilter } = getPeriodFilters(period);
        const pipelineFilter = { propertyName:'pipeline', operator:'IN', values:ALL_PIPELINE_IDS };
        const [allDeals, prevDeals, preVendasAll] = await Promise.all([
          fetchAllDeals(token, [...curFilter,  pipelineFilter]),
          fetchAllDeals(token, [...prevFilter, pipelineFilter]),
          fetchAllDeals(token, [{ propertyName:'pipeline', operator:'EQ', value:PIPELINE_IDS.pre_vendas }]),
        ]);
        const byPipeline = {};
        for (const id of ALL_PIPELINE_IDS) byPipeline[id] = 0;
        for (const deal of allDeals) { const pid = deal.properties.pipeline; if (byPipeline[pid] !== undefined) byPipeline[pid]++; }
        const totalPreVendas = preVendasAll.length;
        const qualificados   = preVendasAll.filter(d => d.properties.dealstage !== BACKLOG_STAGE).length;
        const ativados       = preVendasAll.filter(d => ATIVADO_STAGES.includes(d.properties.dealstage)).length;
        const filteredDeals = pipeline === 'todos' ? allDeals : allDeals.filter(d => d.properties.pipeline === PIPELINE_IDS[pipeline]);
        const prevFiltered  = pipeline === 'todos' ? prevDeals : prevDeals.filter(d => d.properties.pipeline === PIPELINE_IDS[pipeline]);
        const totalNovos = filteredDeals.length;
        const totalPrev  = prevFiltered.length;
        const delta    = totalNovos - totalPrev;
        const deltaPct = totalPrev > 0 ? Math.round(delta / totalPrev * 100) : null;
        const canalCount = {};
        let mapeados = 0;
        for (const deal of filteredDeals) {
          const canal = deal.properties.hub2_deal__canal_de_aquisicao || 'Não definido';
          const det   = deal.properties.detalhamento_de_canal || '';
          canalCount[canal] = (canalCount[canal] || 0) + 1;
          if (det === 'OUT - Lista ABM') mapeados++;
        }
        const segCount = {}, porteCount = {};
        for (const deal of filteredDeals) {
          const seg   = deal.properties.segmento___ibge                  || 'Não definido';
          const porte = deal.properties.hub2_deal__classificacao_do_lead || 'Não definido';
          segCount[seg]     = (segCount[seg]     || 0) + 1;
          porteCount[porte] = (porteCount[porte] || 0) + 1;
        }
        const scorecard = { qualificado:0, a_validar:0, recusar:0, sem_status:0 };
        for (const deal of filteredDeals) {
          const s = (deal.properties.status_da_negociacao || '').toLowerCase();
          if (s.includes('qualificado')) scorecard.qualificado++;
          else if (s.includes('validar')) scorecard.a_validar++;
          else if (s.includes('recusar')) scorecard.recusar++;
          else scorecard.sem_status++;
        }
        const comStatus = scorecard.qualificado + scorecard.a_validar + scorecard.recusar;
        const coberturaScorecard = totalNovos > 0 ? Math.round(comStatus / totalNovos * 100) : 0;
        return res.status(200).json({
          period, pipeline,
          byPipeline: { total:allDeals.length, pre_vendas:byPipeline[PIPELINE_IDS.pre_vendas], smb:byPipeline[PIPELINE_IDS.smb], enterprise:byPipeline[PIPELINE_IDS.enterprise], expansao:byPipeline[PIPELINE_IDS.expansao], rcc:byPipeline[PIPELINE_IDS.rcc] },
          preVendas: { total:totalPreVendas, qualificados, ativados },
          entrada: { total:totalNovos, prevTotal:totalPrev, delta, deltaPct },
          origem: { canais:Object.entries(canalCount).map(([canal,n]) => ({canal,n})).sort((a,b) => b.n-a.n), mapeados, organicos:totalNovos-mapeados },
          perfil: { segmentos:Object.entries(segCount).map(([seg,n]) => ({seg,n,pct:totalNovos>0?Math.round(n/totalNovos*100):0})).sort((a,b) => b.n-a.n).slice(0,5), portes:Object.entries(porteCount).map(([porte,n]) => ({porte,n,pct:totalNovos>0?Math.round(n/totalNovos*100):0})).sort((a,b) => b.n-a.n) },
          scorecard: { ...scorecard, cobertura:coberturaScorecard, total:totalNovos },
        });
      }
      default:
        return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
