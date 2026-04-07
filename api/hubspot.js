// api/hubspot.js — Vercel Serverless Function
// Proxy seguro entre o dashboard e a API do HubSpot

const PIPELINE_IDS = {
  'pre_vendas': '863330820',
  'smb':        '821308952',
  'enterprise': '795451392',
  'expansao':   '874756940',
  'rcc':        '885602211',
};

const ALL_PIPELINE_IDS = Object.values(PIPELINE_IDS);

// Etapas do pipeline Pré Vendas/MKT
// Qualificados = todos exceto Backlog
// Ativados     = a partir de Contato Inicial
const BACKLOG_STAGE    = 'backlog';
const ATIVADO_STAGES   = ['contato_inicial','agendado','reuniao_diagnostico','concluido'];

const DEAL_PROPS = [
  'dealname',
  'pipeline',
  'dealstage',
  'createdate',
  'closedate',
  'hs_lastmodifieddate',
  'hubspot_owner_id',
  'hub2_deal__canal_de_aquisicao',
  'detalhamento_de_canal',
  'segmento___ibge',
  'hub2_deal__classificacao_do_lead',
  'status_da_negociacao',
  'amount',
].join(',');

async function fetchAllDeals(token, filters = [], props = DEAL_PROPS) {
  let deals = [];
  let after = undefined;

  do {
    const body = {
      filterGroups: filters.length ? [{ filters }] : [],
      properties: props.split(','),
      limit: 200,
      ...(after ? { after } : {}),
    };

    const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HubSpot API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    deals = deals.concat(data.results || []);
    after = data.paging?.next?.after;
  } while (after);

  return deals;
}

// ── Period filter ──────────────────────────────────────────────────────────
function getPeriodFilter(period) {
  const now = new Date();
  let start;

  switch (period) {
    case 'semana_atual': {
      const day = now.getDay();
      start = new Date(now);
      start.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
      start.setHours(0, 0, 0, 0);
      break;
    }
    case 'semana_anterior': {
      const day = now.getDay();
      start = new Date(now);
      start.setDate(now.getDate() - (day === 0 ? 6 : day - 1) - 7);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      return [
        { propertyName: 'createdate', operator: 'GTE', value: start.getTime().toString() },
        { propertyName: 'createdate', operator: 'LTE', value: end.getTime().toString() },
      ];
    }
    case 'mes_atual':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'trimestre': {
      const q = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), q * 3, 1);
      break;
    }
    case 'semestre': {
      const h = now.getMonth() < 6 ? 0 : 6;
      start = new Date(now.getFullYear(), h, 1);
      break;
    }
    default:
      start = new Date(now.getFullYear(), now.getMonth(), 1); // default: mes_atual
  }

  return [{ propertyName: 'createdate', operator: 'GTE', value: start.getTime().toString() }];
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return res.status(500).json({ error: 'HUBSPOT_API_KEY not configured' });

  const { endpoint, period = 'mes_atual', pipeline = 'todos' } = req.query;

  try {
    switch (endpoint) {

      // ── Visão Geral: todos os dados numa única chamada ───────────────────
      case 'visao_geral': {
        const periodFilters = getPeriodFilter(period);

        // 1. Busca todos os deals dos 5 pipelines no período
        const pipelineFilter = {
          propertyName: 'pipeline',
          operator: 'IN',
          values: ALL_PIPELINE_IDS,
        };

        const [allDeals, preVendasAll] = await Promise.all([
          fetchAllDeals(token, [...periodFilters, pipelineFilter]),
          // Todos os deals ativos do Pré Vendas (sem filtro de período — para o bloco Pipeline)
          fetchAllDeals(token, [{ propertyName: 'pipeline', operator: 'EQ', value: PIPELINE_IDS.pre_vendas }]),
        ]);

        // ── Novos leads por pipeline ──────────────────────────────────────
        const byPipeline = {};
        for (const id of ALL_PIPELINE_IDS) byPipeline[id] = 0;
        for (const deal of allDeals) {
          const pid = deal.properties.pipeline;
          if (byPipeline[pid] !== undefined) byPipeline[pid]++;
        }

        // ── Pipeline Pré Vendas/MKT ───────────────────────────────────────
        const totalPreVendas   = preVendasAll.length;
        const qualificados     = preVendasAll.filter(d => d.properties.dealstage !== BACKLOG_STAGE).length;
        const ativados         = preVendasAll.filter(d => ATIVADO_STAGES.includes(d.properties.dealstage)).length;

        // ── Entrada de Leads (novos no período, pipeline filtrado) ─────────
        const filteredDeals = pipeline === 'todos'
          ? allDeals
          : allDeals.filter(d => d.properties.pipeline === PIPELINE_IDS[pipeline]);

        const totalNovos = filteredDeals.length;

        // ── Origem dos Leads ──────────────────────────────────────────────
        const canalCount = {};
        const detalhCount = {};
        let mapeados = 0;
        for (const deal of filteredDeals) {
          const canal = deal.properties.hub2_deal__canal_de_aquisicao || 'Não definido';
          const det   = deal.properties.detalhamento_de_canal || '';
          canalCount[canal] = (canalCount[canal] || 0) + 1;
          detalhCount[det]  = (detalhCount[det]  || 0) + 1;
          if (det === 'OUT - Lista ABM') mapeados++;
        }

        // ── Perfil ────────────────────────────────────────────────────────
        const segCount   = {};
        const porteCount = {};
        for (const deal of filteredDeals) {
          const seg   = deal.properties.segmento___ibge                    || 'Não definido';
          const porte = deal.properties.hub2_deal__classificacao_do_lead   || 'Não definido';
          segCount[seg]     = (segCount[seg]     || 0) + 1;
          porteCount[porte] = (porteCount[porte] || 0) + 1;
        }

        // ── Scorecard ─────────────────────────────────────────────────────
        const scorecard = { qualificado: 0, a_validar: 0, recusar: 0, sem_status: 0 };
        for (const deal of filteredDeals) {
          const s = (deal.properties.status_da_negociacao || '').toLowerCase();
          if (s.includes('qualificado'))   scorecard.qualificado++;
          else if (s.includes('validar'))  scorecard.a_validar++;
          else if (s.includes('recusar'))  scorecard.recusar++;
          else                             scorecard.sem_status++;
        }
        const comStatus    = scorecard.qualificado + scorecard.a_validar + scorecard.recusar;
        const coberturaScorecard = totalNovos > 0 ? Math.round(comStatus / totalNovos * 100) : 0;

        return res.status(200).json({
          period,
          pipeline,
          // Bloco: Novos Leads por Pipeline
          byPipeline: {
            total: allDeals.length,
            pre_vendas: byPipeline[PIPELINE_IDS.pre_vendas],
            smb:        byPipeline[PIPELINE_IDS.smb],
            enterprise: byPipeline[PIPELINE_IDS.enterprise],
            expansao:   byPipeline[PIPELINE_IDS.expansao],
            rcc:        byPipeline[PIPELINE_IDS.rcc],
          },
          // Bloco: Pipeline Pré Vendas/MKT
          preVendas: { total: totalPreVendas, qualificados, ativados },
          // Bloco: Entrada de Leads
          entrada: { total: totalNovos },
          // Bloco: Origem dos Leads
          origem: {
            canais: Object.entries(canalCount)
              .map(([canal, n]) => ({ canal, n }))
              .sort((a, b) => b.n - a.n),
            mapeados,
            organicos: totalNovos - mapeados,
          },
          // Bloco: Perfil
          perfil: {
            segmentos: Object.entries(segCount)
              .map(([seg, n]) => ({ seg, n, pct: Math.round(n / totalNovos * 100) }))
              .sort((a, b) => b.n - a.n)
              .slice(0, 5),
            portes: Object.entries(porteCount)
              .map(([porte, n]) => ({ porte, n, pct: Math.round(n / totalNovos * 100) }))
              .sort((a, b) => b.n - a.n),
          },
          // Bloco: Scorecard
          scorecard: {
            ...scorecard,
            cobertura: coberturaScorecard,
            total: totalNovos,
          },
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
