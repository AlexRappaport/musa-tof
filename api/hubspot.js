// api/hubspot.js — Vercel Serverless Function — v3 (dados completos por canal)

const PIPELINE_IDS = {
  pre_vendas: '863330820', smb: '821308952', enterprise: '795451392',
  expansao: '874756940', rcc: '885602211',
};
const ALL_PIPELINE_IDS = Object.values(PIPELINE_IDS);
const PIPELINE_NAMES = {
  '863330820': 'Pré Vendas/MKT', '821308952': 'SMB 3.0',
  '795451392': 'Enterprise 3.0', '874756940': 'Expansão', '885602211': 'RCC',
};
const BACKLOG_STAGE  = 'backlog';
const ATIVADO_STAGES = ['contato_inicial','agendado','reuniao_diagnostico','concluido'];

// ── Regra ABM Qualificado (fonte única de verdade) ───────────────────────────
// Deal com detalhamento_de_canal = 'OUT - Lista ABM' SÓ conta se:
//   a) está nos pipelines SMB / Enterprise / Expansão / RCC (qualquer etapa)
//   b) OU está no Pré Vendas em etapa ≥ Prospecção Direta
const ABM_PROSP_STAGES = ['1292533286','1295430921','1295463995'];
const ABM_OUTROS_PIPES = ['821308952','795451392','874756940','885602211']; // smb, enterprise, expansao, rcc
function isAbm(d) {
  if ((d.properties.detalhamento_de_canal || '') !== 'OUT - Lista ABM') return false;
  const pip   = d.properties.pipeline  || '';
  const stage = d.properties.dealstage || '';
  if (ABM_OUTROS_PIPES.includes(pip)) return true;
  if (pip === '863330820') return ABM_PROSP_STAGES.includes(stage); // pre_vendas
  return false;
}

const DEAL_PROPS = [
  'dealname','pipeline','dealstage','createdate','hs_lastmodifieddate',
  'hubspot_owner_id','hub2_deal__canal_de_aquisicao','detalhamento_de_canal',
  'segmento___ibge','hub2_deal__classificacao_do_lead','status_da_negociacao',
  'hub2_deal__closer','hub2_deal__tipo_negociacao','amount','closedate',
].join(',');

// ── HubSpot helpers ─────────────────────────────────────────────────────────
async function fetchAllDeals(token, filters = []) {
  let deals = [], after;
  do {
    const body = {
      filterGroups: filters.length ? [{ filters }] : [],
      properties: DEAL_PROPS.split(','),
      limit: 200,
      ...(after ? { after } : {}),
    };
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.text(); throw new Error(`HubSpot ${res.status}: ${e}`); }
    const data = await res.json();
    deals = deals.concat(data.results || []);
    after = data.paging?.next?.after;
  } while (after);
  return deals;
}

async function fetchPortalId(token) {
  try {
    const res = await fetch('https://api.hubapi.com/account-info/v3/details', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.portalId || null;
  } catch (e) { return null; }
}

async function fetchOwners(token) {
  try {
    const res = await fetch('https://api.hubapi.com/crm/v3/owners?limit=500', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return {};
    const d = await res.json();
    const map = {};
    for (const o of (d.results || [])) {
      map[String(o.id)] = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || String(o.id);
    }
    return map;
  } catch (e) { return {}; }
}

async function fetchStageMap(token) {
  try {
    const res = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return { labels: {}, lostIds: {} };
    const d = await res.json();
    const labels = {};
    const lostIds = {};
    for (const p of (d.results || [])) {
      for (const s of (p.stages || [])) {
        labels[s.id] = s.label;
        const meta = s.metadata || {};
        const isLostByMeta  = meta.isClosed === 'true' && (meta.probability === '0' || meta.probability === '0.0');
        const isLostByLabel = (s.label || '').toLowerCase().includes('perdido') || (s.label || '').toLowerCase() === 'lost';
        if (isLostByMeta || isLostByLabel) {
          lostIds[s.id] = true;
        }
      }
    }
    return { labels, lostIds };
  } catch (e) { return { labels: {}, lostIds: {} }; }
}

// ── Period filters ───────────────────────────────────────────────────────────
function getPeriodFilters(period) {
  const now = new Date();
  let curStart, curEnd, prevStart, prevEnd;
  switch (period) {
    case 'semana_atual': {
      const d = now.getDay();
      curStart = new Date(now); curStart.setDate(now.getDate() - (d === 0 ? 6 : d - 1)); curStart.setHours(0,0,0,0);
      curEnd = new Date();
      prevStart = new Date(curStart); prevStart.setDate(curStart.getDate() - 7);
      prevEnd   = new Date(curStart); prevEnd.setMilliseconds(-1);
      break;
    }
    case 'semana_anterior': {
      const d = now.getDay();
      curStart = new Date(now); curStart.setDate(now.getDate() - (d === 0 ? 6 : d - 1) - 7); curStart.setHours(0,0,0,0);
      curEnd = new Date(curStart); curEnd.setDate(curStart.getDate() + 6); curEnd.setHours(23,59,59,999);
      prevStart = new Date(curStart); prevStart.setDate(curStart.getDate() - 7);
      prevEnd   = new Date(curStart); prevEnd.setMilliseconds(-1);
      break;
    }
    case 'trimestre': {
      const q = Math.floor(now.getMonth() / 3);
      curStart = new Date(now.getFullYear(), q * 3, 1); curEnd = new Date();
      prevStart = new Date(now.getFullYear(), (q - 1) * 3, 1);
      prevEnd   = new Date(curStart); prevEnd.setMilliseconds(-1);
      break;
    }
    case 'semestre': {
      const h = now.getMonth() < 6 ? 0 : 6;
      curStart = new Date(now.getFullYear(), h, 1); curEnd = new Date();
      prevStart = new Date(h === 0 ? now.getFullYear() - 1 : now.getFullYear(), h === 0 ? 6 : 0, 1);
      prevEnd   = new Date(curStart); prevEnd.setMilliseconds(-1);
      break;
    }
    default: { // mes_atual
      curStart = new Date(now.getFullYear(), now.getMonth(), 1); curEnd = new Date();
      prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      prevEnd   = new Date(curStart); prevEnd.setMilliseconds(-1);
    }
  }
  const mkFilter = (s, e) => [
    { propertyName: 'createdate', operator: 'GTE', value: s.getTime().toString() },
    { propertyName: 'createdate', operator: 'LTE', value: e.getTime().toString() },
  ];
  return { curFilter: mkFilter(curStart, curEnd), prevFilter: mkFilter(prevStart, prevEnd) };
}

// ── Canal aggregation ────────────────────────────────────────────────────────
function aggregateCanais(curDeals, prevDeals, ownerMap, stageMap, portalId) {
  const map = {};

  for (const deal of curDeals) {
    const canal = deal.properties.hub2_deal__canal_de_aquisicao || 'Não definido';
    if (!map[canal]) map[canal] = { canal, count: 0, qualif: 0, portes: {}, tipos: {}, deals: [], prevCount: 0 };
    const m = map[canal];
    m.count++;

    const status = (deal.properties.status_da_negociacao || '').toLowerCase();
    const stage  = (deal.properties.dealstage || '').toLowerCase();
    // Qualificado = status contém 'qualificado' OU etapa avançou além de backlog/prospecção
    const isQualif = status.includes('qualificado') ||
      (!stage.includes('backlog') && !stage.includes('prospeccao') && !stage.includes('prospecção') && stage !== '');
    if (isQualif) m.qualif++;

    const porte = deal.properties.hub2_deal__classificacao_do_lead || '—';
    m.portes[porte] = (m.portes[porte] || 0) + 1;

    const tipo = deal.properties.hub2_deal__tipo_negociacao || '—';
    m.tipos[tipo] = (m.tipos[tipo] || 0) + 1;

    const ownerId  = String(deal.properties.hubspot_owner_id || '');
    const closerId = String(deal.properties.hub2_deal__closer || '');
    const stageId  = deal.properties.dealstage || '';
    const pipeId   = deal.properties.pipeline  || '';

    // Closer: pode ser ID numérico ou texto livre
    const closerVal = /^\d+$/.test(closerId) ? (ownerMap[closerId] || closerId || '—') : (closerId || '—');
    const respVal   = ownerMap[ownerId] || ownerId || '—';
    const stageLbl  = stageMap[stageId] || stageId || '—';
    const pipeLbl   = PIPELINE_NAMES[pipeId] || pipeId || '—';

    const createTs = new Date(deal.properties.createdate);
    const lastTs   = new Date(deal.properties.hs_lastmodifieddate);
    const diasCreate = Math.floor((Date.now() - createTs.getTime()) / 86400000);
    const diasLast   = Math.floor((Date.now() - lastTs.getTime())   / 86400000);

    m.deals.push({
      id:        deal.id,
      nome:      deal.properties.dealname || '—',
      entrada:   createTs.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
      pipeline:  pipeLbl,
      etapa:     stageLbl,
      responsavel: respVal,
      closer:    closerVal,
      porte:     deal.properties.hub2_deal__classificacao_do_lead || '—',
      tipo:      deal.properties.hub2_deal__tipo_negociacao || '—',
      diasCriado: diasCreate,
      diasUltInt: diasLast,
      ultimaInteracao: lastTs.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
      hubspotUrl: portalId ? `https://app.hubspot.com/contacts/${portalId}/deal/${deal.id}` : null,
    });
  }

  // Previous period counts per canal
  for (const deal of prevDeals) {
    const canal = deal.properties.hub2_deal__canal_de_aquisicao || 'Não definido';
    if (map[canal]) map[canal].prevCount++;
    // count even if not in current (for WOW reference)
    else {
      if (!map[canal]) map[canal] = { canal, count: 0, qualif: 0, portes: {}, tipos: {}, deals: [], prevCount: 0 };
      map[canal].prevCount++;
    }
  }

  return Object.values(map)
    .filter(m => m.count > 0) // apenas canais com deals no período atual
    .map(m => {
      const total    = m.count;
      const delta    = m.count - m.prevCount;
      const deltaPct = m.prevCount > 0 ? Math.round(delta / m.prevCount * 100) : null;
      const qualifPct = total > 0 ? Math.round(m.qualif / total * 100) : 0;

      // porte breakdown
      const porteEntries = Object.entries(m.portes).map(([k, n]) => ({
        label: k, n, pct: Math.round(n / total * 100),
      })).sort((a, b) => b.n - a.n);

      // new logo vs expansão
      const newLogo = m.tipos['New Logo'] || 0;
      const expansao = m.tipos['Expansão'] || m.tipos['Expansao'] || 0;
      const bid      = m.tipos['BID'] || m.tipos['Bid'] || 0;
      const newLogoPct = total > 0 ? Math.round(newLogo / total * 100) : 0;
      const expansaoPct = total > 0 ? Math.round(expansao / total * 100) : 0;

      return {
        canal: m.canal,
        n: m.count, prevN: m.prevCount, delta, deltaPct,
        qualifPct,
        portes: porteEntries,
        newLogo: { n: newLogo, pct: newLogoPct },
        expansao: { n: expansao, pct: expansaoPct },
        bid: { n: bid, pct: total > 0 ? Math.round(bid / total * 100) : 0 },
        deals: m.deals.sort((a, b) => a.diasCriado - b.diasCriado),
      };
    })
    .sort((a, b) => b.n - a.n);
}

// ── Event deal IDs (tickets associados a deals via "Show no evento") ─────────
async function fetchEventDealIds(token) {
  try {
    // 1. Buscar todos os tickets do pipeline Eventos na stage "Show no evento"
    let tickets = [], after;
    do {
      const body = {
        filterGroups: [{ filters: [
          { propertyName: 'hs_pipeline',       operator: 'EQ', value: '872857629' },
          { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: '1308097367' },
        ]}],
        properties: ['hs_pipeline_stage'],
        limit: 200,
        ...(after ? { after } : {}),
      };
      const res = await fetch('https://api.hubapi.com/crm/v3/objects/tickets/search', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return new Set();
      const data = await res.json();
      tickets = tickets.concat(data.results || []);
      after = data.paging?.next?.after;
    } while (after);

    if (!tickets.length) return new Set();

    // 2. Batch: para cada ticket, buscar os deals associados
    const assocRes = await fetch('https://api.hubapi.com/crm/v4/associations/tickets/deals/batch/read', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: tickets.map(t => ({ id: t.id })) }),
    });
    if (!assocRes.ok) return new Set();
    const assocData = await assocRes.json();

    const dealIds = new Set();
    for (const result of (assocData.results || [])) {
      for (const assoc of (result.to || [])) {
        dealIds.add(String(assoc.toObjectId));
      }
    }
    return dealIds;
  } catch (e) {
    return new Set(); // falha silenciosa — não quebra o funil
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
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
        const pipeFilter = { propertyName: 'pipeline', operator: 'IN', values: ALL_PIPELINE_IDS };

        // Fetch tudo em paralelo — max 4 chamadas para evitar rate limit
        const [allDeals, prevDeals, preVendasAll, stageData] = await Promise.all([
          fetchAllDeals(token, [...curFilter,  pipeFilter]),
          fetchAllDeals(token, [...prevFilter, pipeFilter]),
          fetchAllDeals(token, [{ propertyName: 'pipeline', operator: 'EQ', value: PIPELINE_IDS.pre_vendas }]),
          fetchStageMap(token),
        ]);

        // Fetch owners e portalId em sequência leve após os deals
        const [portalId, ownerMap] = await Promise.all([
          fetchPortalId(token),
          fetchOwners(token),
        ]);

        const stageMap  = stageData.labels  || {};
        const lostIds   = stageData.lostIds || {};

        // Excluir deals em etapa "Perdido" (closed-lost) da contagem de leads
        const activeDeals     = allDeals.filter(d => !lostIds[d.properties.dealstage]);
        const activePrevDeals = prevDeals.filter(d => !lostIds[d.properties.dealstage]);

        // By pipeline
        const byPipeline = {};
        for (const id of ALL_PIPELINE_IDS) byPipeline[id] = 0;
        for (const d of activeDeals) { const p = d.properties.pipeline; if (byPipeline[p] !== undefined) byPipeline[p]++; }

        // Pré Vendas stats (sem filtro de período — snapshot atual, inclui todos os estágios)
        const totalPreVendas = preVendasAll.length;
        const qualificados   = preVendasAll.filter(d => d.properties.dealstage !== BACKLOG_STAGE).length;
        const ativados       = preVendasAll.filter(d => ATIVADO_STAGES.includes(d.properties.dealstage)).length;

        // Filtered by pipeline pill
        const filteredDeals = pipeline === 'todos' ? activeDeals : activeDeals.filter(d => d.properties.pipeline === PIPELINE_IDS[pipeline]);
        const prevFiltered  = pipeline === 'todos' ? activePrevDeals : activePrevDeals.filter(d => d.properties.pipeline === PIPELINE_IDS[pipeline]);

        const totalNovos = filteredDeals.length;
        const totalPrev  = prevFiltered.length;
        const delta      = totalNovos - totalPrev;
        const deltaPct   = totalPrev > 0 ? Math.round(delta / totalPrev * 100) : null;

        // Canal aggregation (rich)
        const canais = aggregateCanais(filteredDeals, prevFiltered, ownerMap, stageMap, portalId);

        // Mapeado vs orgânico
        let mapeados = 0;
        for (const d of filteredDeals) { if ((d.properties.detalhamento_de_canal || '') === 'OUT - Lista ABM') mapeados++; }

        // Perfil
        const segCount = {}, porteCount = {};
        for (const d of filteredDeals) {
          const seg   = d.properties.segmento___ibge                  || 'Não definido';
          const porte = d.properties.hub2_deal__classificacao_do_lead || 'Não definido';
          segCount[seg]     = (segCount[seg]     || 0) + 1;
          porteCount[porte] = (porteCount[porte] || 0) + 1;
        }

        // Scorecard
        const sc = { qualificado: 0, a_validar: 0, recusar: 0, sem_status: 0 };
        for (const d of filteredDeals) {
          const s = (d.properties.status_da_negociacao || '').toLowerCase();
          if (s.includes('qualificado')) sc.qualificado++;
          else if (s.includes('validar')) sc.a_validar++;
          else if (s.includes('recusar')) sc.recusar++;
          else sc.sem_status++;
        }
        const comStatus = sc.qualificado + sc.a_validar + sc.recusar;
        const cobertura = totalNovos > 0 ? Math.round(comStatus / totalNovos * 100) : 0;

        return res.status(200).json({
          period, pipeline, portalId,
          byPipeline: {
            total: activeDeals.length, pre_vendas: byPipeline[PIPELINE_IDS.pre_vendas],
            smb: byPipeline[PIPELINE_IDS.smb], enterprise: byPipeline[PIPELINE_IDS.enterprise],
            expansao: byPipeline[PIPELINE_IDS.expansao], rcc: byPipeline[PIPELINE_IDS.rcc],
          },
          preVendas: { total: totalPreVendas, qualificados, ativados },
          entrada:   { total: totalNovos, prevTotal: totalPrev, delta, deltaPct },
          origem:    { canais, mapeados, organicos: totalNovos - mapeados },
          perfil: {
            segmentos: Object.entries(segCount).map(([seg, n]) => ({ seg, n, pct: totalNovos > 0 ? Math.round(n / totalNovos * 100) : 0 })).sort((a, b) => b.n - a.n).slice(0, 5),
            portes:    Object.entries(porteCount).map(([porte, n]) => ({ porte, n, pct: totalNovos > 0 ? Math.round(n / totalNovos * 100) : 0 })).sort((a, b) => b.n - a.n),
          },
          scorecard: { ...sc, cobertura, total: totalNovos },
        });
      }
      case 'funil_kpis': {
        const PROPOSTA_IDS_KPI      = [
          // SMB: Prop. Aceita, Elaboração, Contrato Enviado, Concluído
          '1214475912','1214475913','1214475914','1214475915',
          // Enterprise: Prop. Aceita, Elaboração, Aguardando Assinatura, Concluído
          '1224336643','1166521949','1224196453','1166521951',
          // Expansão: Prop. Aceita, Elaboração de Contrato, Concluído
          '1311051331','1311051332','1311052411',
          // RCC: Proposta Aceita, Concluído
          '1331859376','1331859377',
        ];
        const PRE_VENDAS_KPI        = PIPELINE_IDS.pre_vendas;
        const OUTROS_PIPELINES      = [PIPELINE_IDS.smb, PIPELINE_IDS.enterprise, PIPELINE_IDS.expansao, PIPELINE_IDS.rcc];
        const REUNIAO_STAGES        = ['1295430921','1295463995'];

        function getKpiRange(p) {
          const now = new Date();
          if (p === 'wtd') {
            const d = now.getDay();
            const s = new Date(now); s.setDate(now.getDate() - (d === 0 ? 6 : d - 1)); s.setHours(0,0,0,0);
            return [s.getTime().toString(), now.getTime().toString()];
          }
          if (p === 'ytd') {
            return [new Date(now.getFullYear(), 0, 1).getTime().toString(), now.getTime().toString()];
          }
          return [new Date(now.getFullYear(), now.getMonth(), 1).getTime().toString(), now.getTime().toString()];
        }

        const kpiPeriod = req.query.kpi_period || 'mtd';
        const [pStart, pEnd] = getKpiRange(kpiPeriod);

        // Fetch deals + stageMap + event deal IDs em paralelo
        const [rawDeals, stageData, eventDealIds] = await Promise.all([
          fetchAllDeals(token, [
            { propertyName: 'createdate', operator: 'GTE', value: pStart },
            { propertyName: 'createdate', operator: 'LTE', value: pEnd  },
            { propertyName: 'pipeline',   operator: 'IN',  values: ALL_PIPELINE_IDS },
          ]),
          fetchStageMap(token),
          fetchEventDealIds(token),
        ]);

        const kpiLostIds = stageData.lostIds || {};

        const kpiDeals = rawDeals.filter(d => {
          if (kpiLostIds[d.properties.dealstage]) return false;
          const detalhe = d.properties.detalhamento_de_canal || '';
          if (detalhe === 'OUT - Lista ABM') return isAbm(d);
          return true;
        });

        const total    = kpiDeals.length;
        const pct      = n => total > 0 ? Math.round(n / total * 100) : 0;

        const mkt = kpiDeals.filter(d => {
          const canal = (d.properties.hub2_deal__canal_de_aquisicao || '').toLowerCase();
          return canal.includes('inbound') || isAbm(d) || eventDealIds.has(d.id);
        }).length;

        const mapeados  = kpiDeals.filter(d => isAbm(d)).length;
        const reunioes  = kpiDeals.filter(d =>
          (d.properties.pipeline === PRE_VENDAS_KPI && REUNIAO_STAGES.includes(d.properties.dealstage)) ||
          OUTROS_PIPELINES.includes(d.properties.pipeline)
        ).length;
        const propostas = kpiDeals.filter(d => PROPOSTA_IDS_KPI.includes(d.properties.dealstage)).length;

        return res.status(200).json({
          kpi_period: kpiPeriod, total,
          mkt:      { n: mkt,       pct: pct(mkt)       },
          mapeados: { n: mapeados,  pct: pct(mapeados)  },
          reuniao:  { n: reunioes,  pct: pct(reunioes)  },
          proposta: { n: propostas, pct: pct(propostas) },
        });
      }

      case 'funil_chart': {
        const chartMode = req.query.mode || 'wtd';
        const now = new Date();
        const MONTH_NAMES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        const REUN_C   = ['1295430921','1295463995'];
        const CONTR_C  = [
          // SMB: Prop. Aceita, Elaboração, Contrato Enviado, Concluído
          '1214475912','1214475913','1214475914','1214475915',
          // Enterprise: Prop. Aceita, Elaboração, Aguardando Assinatura, Concluído
          '1224336643','1166521949','1224196453','1166521951',
          // Expansão: Prop. Aceita, Elaboração de Contrato, Concluído
          '1311051331','1311051332','1311052411',
          // RCC: Proposta Aceita, Concluído
          '1331859376','1331859377',
        ];

        // Build 5 period ranges
        const periods = [];
        if (chartMode === 'wtd') {
          const day = now.getDay();
          const thisMon = new Date(now);
          thisMon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
          thisMon.setHours(0,0,0,0);
          for (let i = 4; i >= 0; i--) {
            const s = new Date(thisMon); s.setDate(thisMon.getDate() - i * 7);
            const e = i === 0 ? new Date() : new Date(s); if (i > 0) { e.setDate(s.getDate() + 6); e.setHours(23,59,59,999); }
            periods.push({ label: i === 0 ? 'Atual' : 'S-' + i, start: s.getTime(), end: e.getTime() });
          }
        } else {
          for (let i = 4; i >= 0; i--) {
            const s = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const e = i === 0 ? new Date() : new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
            periods.push({ label: MONTH_NAMES[s.getMonth()], month: s.getFullYear() + '-' + String(s.getMonth()+1).padStart(2,'0'), start: s.getTime(), end: e.getTime() });
          }
        }

        // Fetch all deals in full range + stageMap + event deal IDs in parallel
        const [rawAll, stageD, eventDealIds] = await Promise.all([
          fetchAllDeals(token, [
            { propertyName: 'createdate', operator: 'GTE', value: String(periods[0].start) },
            { propertyName: 'createdate', operator: 'LTE', value: String(periods[periods.length-1].end) },
            { propertyName: 'pipeline',   operator: 'IN',  values: ALL_PIPELINE_IDS },
          ]),
          fetchStageMap(token),
          fetchEventDealIds(token),
        ]);

        const lostC = (stageD && stageD.lostIds) || {};

        const chartData = periods.map(function(p) {
          const pDeals = rawAll.filter(function(d) {
            const t = new Date(d.properties.createdate).getTime();
            if (t < p.start || t > p.end) return false;
            if (lostC[d.properties.dealstage]) return false;
            if ((d.properties.detalhamento_de_canal || '') === 'OUT - Lista ABM') return isAbm(d);
            return true;
          });
          const total    = pDeals.length;
          const mkt      = pDeals.filter(function(d){ const c=(d.properties.hub2_deal__canal_de_aquisicao||'').toLowerCase(); return c.includes('inbound')||isAbm(d)||eventDealIds.has(d.id); }).length;
          const mapeados = pDeals.filter(isAbm).length;
          const reuniao  = pDeals.filter(function(d){ return (d.properties.pipeline===PIPELINE_IDS.pre_vendas&&REUN_C.includes(d.properties.dealstage))||ABM_OUTROS_PIPES.includes(d.properties.pipeline); }).length;
          const contratos= pDeals.filter(function(d){ return CONTR_C.includes(d.properties.dealstage); }).length;
          return { label: p.label, month: p.month||null, total, mkt, naoMkt: total-mkt, mapeados, naoMapeados: total-mapeados, reuniao, naoReuniao: total-reuniao, contratos, semContrato: total-contratos };
        });

        return res.status(200).json({ mode: chartMode, data: chartData });
      }

      default:
        return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
