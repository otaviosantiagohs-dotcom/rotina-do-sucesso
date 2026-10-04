/* Rotina do Sucesso — Dashboard Ao Vivo
   V8.9.3 — integração modular otimizada para reduzir leitura e egress.

   - 1ª abertura: carrega o mês corrente.
   - Auto refresh (30 min): consulta somente o dia atual.
   - Atualizar agora: força sincronização completa do mês.
   - Filtros Hoje/Mês/Empresa/Unidade/Indicador: locais, sem nova consulta.
   - Fora do módulo: sem polling.
*/

(function(){
  'use strict';

  const state = {
    busy:false,
    active:false,
    mounted:false,
    orgCheckedAt:0,
    loadedMonth:null,
    monthRows:[],
    lastFullSyncAt:0,
    lastTodaySyncAt:0
  };

  const ORG_CACHE_MS = 30 * 60 * 1000;

  function frame(){
    return document.getElementById('liveDashboardFrame');
  }

  function mount(){
    const el=frame();
    if(!el)return null;

    if(!state.mounted){
      const src=el.dataset.src;
      if(src && !el.getAttribute('src')){
        el.setAttribute('src',src);
      }
      state.mounted=true;
    }
    return el;
  }

  function sendVisibility(){
    const el=frame();
    if(!el?.contentWindow)return;
    el.contentWindow.postMessage(
      {type:'rotina-live-visibility',active:state.active},
      window.location.origin
    );
  }

  async function ensureOrganization(){
    const now=Date.now();
    const missing=!ORG_UNITS_DB.length || !ORG_COMPANIES_DB.length || !ORG_PROFILES_DB.length;

    if(missing || now-state.orgCheckedAt>ORG_CACHE_MS){
      await loadDashboardReferenceData();
      state.orgCheckedAt=now;
    }
  }

  async function fetchFullMonth(today){
    const month=today.slice(0,7);
    const monthStart=`${month}-01`;

    const {data,error}=await supabaseClient
      .from('daily_routines')
      .select('user_id,unit_id,routine_date,floor_approaches,online_captures,quotations')
      .gte('routine_date',monthStart)
      .lte('routine_date',today)
      .order('routine_date',{ascending:true});

    if(error)throw error;

    state.loadedMonth=month;
    state.monthRows=data||[];
    state.lastFullSyncAt=Date.now();
    state.lastTodaySyncAt=state.lastFullSyncAt;
  }

  async function fetchTodayOnly(today){
    const {data,error}=await supabaseClient
      .from('daily_routines')
      .select('user_id,unit_id,routine_date,floor_approaches,online_captures,quotations')
      .eq('routine_date',today);

    if(error)throw error;

    state.monthRows=[
      ...state.monthRows.filter(r=>r.routine_date!==today),
      ...(data||[])
    ];
    state.lastTodaySyncAt=Date.now();
  }

  async function syncRows(reason,today){
    const month=today.slice(0,7);
    const cacheMissing=state.loadedMonth!==month || state.monthRows.length===0;

    if(cacheMissing || reason==='initial' || reason==='manual'){
      await fetchFullMonth(today);
      return;
    }

    await fetchTodayOnly(today);
  }

  function buildPayload(today){
    const month=today.slice(0,7);
    const companyById=new Map(ORG_COMPANIES_DB.map(c=>[c.id,c]));

    const activeUnits=ORG_UNITS_DB.filter(u=>{
      const c=companyById.get(u.company_id);
      return u.active!==false && c?.active!==false;
    });

    const capacityByUnit=new Map();
    ORG_PROFILES_DB.forEach(p=>{
      if(!['colaborador','gerente'].includes(p.role) || p.active!==true || !p.unit_id)return;
      capacityByUnit.set(p.unit_id,(capacityByUnit.get(p.unit_id)||0)+1);
    });

    const storeMap=new Map();

    activeUnits.forEach(u=>{
      const c=companyById.get(u.company_id);

      storeMap.set(u.id,{
        id:u.id,
        name:u.short_code||u.name,
        unitName:u.name,
        company:c?.name||'',
        capacity:capacityByUnit.get(u.id)||0,
        dayActive:new Set(),
        monthActive:new Set(),
        day:{salao:0,online:0,cotacoes:0},
        month:{salao:0,online:0,cotacoes:0},
        daily:{}
      });
    });

    state.monthRows.forEach(r=>{
      const s=storeMap.get(r.unit_id);
      if(!s)return;

      const salao=Number(r.floor_approaches||0);
      const online=Number(r.online_captures||0);
      const cotacoes=Number(r.quotations||0);
      const activity=salao+online+cotacoes;

      s.month.salao+=salao;
      s.month.online+=online;
      s.month.cotacoes+=cotacoes;

      const dayKey=String(r.routine_date).slice(8,10);
      if(!s.daily[dayKey])s.daily[dayKey]={salao:0,online:0,cotacoes:0};

      s.daily[dayKey].salao+=salao;
      s.daily[dayKey].online+=online;
      s.daily[dayKey].cotacoes+=cotacoes;

      if(activity>0)s.monthActive.add(r.user_id);

      if(r.routine_date===today){
        s.day.salao+=salao;
        s.day.online+=online;
        s.day.cotacoes+=cotacoes;
        if(activity>0)s.dayActive.add(r.user_id);
      }
    });

    const stores=[...storeMap.values()].map(s=>({
      id:s.id,
      name:s.name,
      unitName:s.unitName,
      company:s.company,
      capacity:s.capacity,
      dayActiveAgents:s.dayActive.size,
      monthActiveAgents:s.monthActive.size,
      day:s.day,
      month:s.month,
      daily:s.daily
    }));

    return {
      today,
      month,
      generatedAt:new Date().toISOString(),
      stores
    };
  }

  async function refresh(targetWindow=null,reason='manual'){
    if(!state.active || state.busy)return;

    const el=mount();
    const target=targetWindow||el?.contentWindow;
    if(!target)return;

    state.busy=true;

    try{
      await ensureOrganization();

      const today=currentBusinessDate();
      await syncRows(reason,today);

      target.postMessage(
        {type:'rotina-live-data',payload:buildPayload(today)},
        window.location.origin
      );
    }catch(err){
      console.error('Dashboard Ao Vivo:',err);
      target.postMessage({
        type:'rotina-live-error',
        message:err?.message||'Falha ao atualizar'
      },window.location.origin);
    }finally{
      state.busy=false;
    }
  }

  function setActive(active){
    state.active=active===true;

    if(state.active){
      mount();
      sendVisibility();
    }else{
      sendVisibility();
    }
  }

  window.addEventListener('message',event=>{
    const el=frame();

    if(
      event.origin!==window.location.origin ||
      !el ||
      event.source!==el.contentWindow
    )return;

    if(event.data?.type==='rotina-live-request' && state.active){
      const reason=['initial','auto','manual','resume'].includes(event.data.reason)
        ? event.data.reason
        : 'manual';

      refresh(event.source,reason);
    }
  });

  document.addEventListener('DOMContentLoaded',()=>{
    const el=frame();
    if(!el)return;

    el.addEventListener('load',()=>{
      sendVisibility();
      // O iframe solicita a primeira leitura ao receber visibility=true.
      // Não fazemos uma segunda consulta aqui.
    });
  });

  window.LiveDashboardBridge={
    setActive,
    refresh:(reason='manual')=>refresh(null,reason),
    getState:()=>({
      busy:state.busy,
      active:state.active,
      mounted:state.mounted,
      loadedMonth:state.loadedMonth,
      cachedRows:state.monthRows.length,
      lastFullSyncAt:state.lastFullSyncAt,
      lastTodaySyncAt:state.lastTodaySyncAt
    })
  };
})();
