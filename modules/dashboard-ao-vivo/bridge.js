/* Rotina de Sucesso — Dashboard Ao Vivo
   V9.5.8 — sincronização contínua do dia.

   Comportamento:
   - a sincronização inicia quando uma sessão Performance/Supabase entra;
   - continua mesmo quando o usuário navega para outras áreas do sistema;
   - alterações em daily_routines disparam atualização por Supabase Realtime;
   - existe um heartbeat de segurança a cada 15 minutos;
   - ao retornar ao app/rede, o dia atual é sincronizado imediatamente;
   - abrir a Dashboard Ao Vivo apenas exibe um estado que já vem sendo mantido;
   - filtros Hoje/Mês/Empresa/Unidade/Indicador continuam locais.
*/

(function(){
  'use strict';

  const BACKGROUND_SYNC_MS = 15 * 60 * 1000;
  const ORG_CACHE_MS = 15 * 60 * 1000;
  const REALTIME_DEBOUNCE_MS = 650;
  const RESUME_MIN_GAP_MS = 15 * 1000;

  const state = {
    busy:false,
    active:false,              // visibilidade da Dashboard Ao Vivo
    sessionSync:false,         // sincronização contínua da sessão
    mounted:false,
    orgCheckedAt:0,
    loadedMonth:null,
    monthRows:[],
    lastFullSyncAt:0,
    lastTodaySyncAt:0,
    lastAnySyncAt:0,
    backgroundTimer:null,
    realtimeChannel:null,
    realtimeDebounce:null,
    pendingReason:null
  };

  function frame(){
    return document.getElementById('liveDashboardFrame');
  }

  function isPerformanceSession(){
    try{
      return !!(
        window.currentUser &&
        currentUser.role==='performance' &&
        currentUser.source==='supabase' &&
        window.supabaseClient
      );
    }catch(_){
      return false;
    }
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

  function postPayload(payload,targetWindow=null){
    const target=targetWindow || frame()?.contentWindow;
    if(!target)return;
    target.postMessage(
      {type:'rotina-live-data',payload},
      window.location.origin
    );
  }

  function postError(err,targetWindow=null){
    const target=targetWindow || frame()?.contentWindow;
    if(!target)return;
    target.postMessage({
      type:'rotina-live-error',
      message:err?.message||'Falha ao atualizar'
    },window.location.origin);
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
      .select('user_id,unit_id,routine_date,floor_approaches,online_captures,quotations,sales')
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
      .select('user_id,unit_id,routine_date,floor_approaches,online_captures,quotations,sales')
      .eq('routine_date',today);

    if(error)throw error;

    const month=today.slice(0,7);

    // Se o mês ainda não foi carregado, o dia fica como cache provisório.
    // A primeira carga completa será feita no start da sessão ou no rollover.
    if(state.loadedMonth!==month){
      state.loadedMonth=month;
      state.monthRows=data||[];
    }else{
      state.monthRows=[
        ...state.monthRows.filter(r=>r.routine_date!==today),
        ...(data||[])
      ];
    }

    state.lastTodaySyncAt=Date.now();
  }

  async function syncRows(reason,today){
    const month=today.slice(0,7);
    const cacheMissing=state.loadedMonth!==month || state.monthRows.length===0;

    // Carga completa só quando realmente necessária.
    if(
      cacheMissing ||
      reason==='session-start' ||
      reason==='manual' ||
      reason==='month-rollover'
    ){
      await fetchFullMonth(today);
      return;
    }

    // Realtime, heartbeat, abertura e retorno consultam somente o dia atual.
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
        day:{salao:0,online:0,cotacoes:0,vendas:0},
        month:{salao:0,online:0,cotacoes:0,vendas:0},
        daily:{}
      });
    });

    state.monthRows.forEach(r=>{
      const s=storeMap.get(r.unit_id);
      if(!s)return;

      const salao=Number(r.floor_approaches||0);
      const online=Number(r.online_captures||0);
      const cotacoes=Number(r.quotations||0);
      const vendas=Number(r.sales||0);
      const activity=salao+online+cotacoes;

      s.month.salao+=salao;
      s.month.online+=online;
      s.month.cotacoes+=cotacoes;
      s.month.vendas+=vendas;

      const dayKey=String(r.routine_date).slice(8,10);
      if(!s.daily[dayKey])s.daily[dayKey]={salao:0,online:0,cotacoes:0,vendas:0};

      s.daily[dayKey].salao+=salao;
      s.daily[dayKey].online+=online;
      s.daily[dayKey].cotacoes+=cotacoes;
      s.daily[dayKey].vendas+=vendas;

      if(activity>0)s.monthActive.add(r.user_id);

      if(r.routine_date===today){
        s.day.salao+=salao;
        s.day.online+=online;
        s.day.cotacoes+=cotacoes;
        s.day.vendas+=vendas;
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
      syncMode:'continuous',
      stores
    };
  }

  async function runSync(reason='background',targetWindow=null){
    if(!isPerformanceSession())return;

    if(state.busy){
      // Não perde uma alteração que chegou durante uma consulta.
      state.pendingReason=reason;
      return;
    }

    state.busy=true;

    try{
      await ensureOrganization();

      const today=currentBusinessDate();
      const previousMonth=state.loadedMonth;
      const currentMonth=today.slice(0,7);

      const effectiveReason=
        previousMonth && previousMonth!==currentMonth
          ? 'month-rollover'
          : reason;

      await syncRows(effectiveReason,today);

      const payload=buildPayload(today);
      payload.reason=reason;
      state.lastAnySyncAt=Date.now();

      // Mesmo quando a dashboard está escondida, se o iframe já foi montado,
      // mantemos o DOM dele sincronizado em segundo plano.
      postPayload(payload,targetWindow);

      window.dispatchEvent(new CustomEvent('rds-live-sync',{
        detail:{
          reason,
          generatedAt:payload.generatedAt,
          today:payload.today
        }
      }));
    }catch(err){
      console.error('Dashboard Ao Vivo:',err);
      postError(err,targetWindow);
    }finally{
      state.busy=false;

      if(state.pendingReason){
        const next=state.pendingReason;
        state.pendingReason=null;
        setTimeout(()=>runSync(next),50);
      }
    }
  }

  function scheduleRealtimeSync(){
    if(!state.sessionSync)return;
    clearTimeout(state.realtimeDebounce);
    state.realtimeDebounce=setTimeout(()=>{
      runSync('realtime');
    },REALTIME_DEBOUNCE_MS);
  }

  function startRealtime(){
    if(!isPerformanceSession() || state.realtimeChannel)return;

    try{
      state.realtimeChannel=supabaseClient
        .channel(`rds-live-routines-${currentUser.id||currentUser.authUserId||currentUser.username||'performance'}`)
        .on(
          'postgres_changes',
          {event:'*',schema:'public',table:'daily_routines'},
          payload=>{
            if(!state.sessionSync)return;

            const today=currentBusinessDate();
            const rowDate=
              payload?.new?.routine_date ||
              payload?.old?.routine_date ||
              null;

            // O foco do modo contínuo é o dia atual.
            if(rowDate && rowDate!==today)return;

            scheduleRealtimeSync();
          }
        )
        .subscribe(status=>{
          if(status==='CHANNEL_ERROR' || status==='TIMED_OUT'){
            console.warn('Dashboard Ao Vivo: Realtime indisponível; heartbeat de 15 min continua ativo.');
          }
        });
    }catch(err){
      console.warn('Dashboard Ao Vivo: falha ao iniciar Realtime; usando heartbeat.',err);
    }
  }

  async function stopRealtime(){
    clearTimeout(state.realtimeDebounce);
    state.realtimeDebounce=null;

    if(state.realtimeChannel){
      try{
        await supabaseClient.removeChannel(state.realtimeChannel);
      }catch(_){}
      state.realtimeChannel=null;
    }
  }

  function startHeartbeat(){
    if(state.backgroundTimer)clearInterval(state.backgroundTimer);

    state.backgroundTimer=setInterval(()=>{
      if(!state.sessionSync || !isPerformanceSession())return;
      runSync('heartbeat');
    },BACKGROUND_SYNC_MS);
  }

  function stopHeartbeat(){
    if(state.backgroundTimer){
      clearInterval(state.backgroundTimer);
      state.backgroundTimer=null;
    }
  }

  function startSession(){
    if(!isPerformanceSession()){
      stopSession();
      return;
    }

    if(state.sessionSync)return;

    state.sessionSync=true;
    startHeartbeat();
    startRealtime();

    // Sincroniza imediatamente no login, sem depender de abrir a dashboard.
    runSync('session-start');
  }

  function stopSession(){
    state.sessionSync=false;
    state.active=false;
    stopHeartbeat();
    stopRealtime();
    clearTimeout(state.realtimeDebounce);
    state.realtimeDebounce=null;
    state.pendingReason=null;
    sendVisibility();
  }

  function setActive(active){
    state.active=active===true;

    if(state.active){
      const el=mount();
      sendVisibility();

      // Se a sessão contínua ainda não iniciou por qualquer motivo, inicia agora.
      if(!state.sessionSync)startSession();

      // Abertura mostra o cache atual e confirma o dia no banco.
      if(el?.contentWindow && state.monthRows.length){
        const today=currentBusinessDate();
        const payload=buildPayload(today);
        payload.reason='resume';
        postPayload(payload,el.contentWindow);
      }
      runSync('open');
    }else{
      // Sair visualmente do módulo NÃO interrompe a sincronização.
      sendVisibility();
    }
  }

  function refresh(targetWindow=null,reason='manual'){
    return runSync(reason,targetWindow);
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

      runSync(reason,event.source);
    }
  });

  document.addEventListener('DOMContentLoaded',()=>{
    const el=frame();
    if(!el)return;

    el.addEventListener('load',()=>{
      sendVisibility();

      if(state.monthRows.length){
        const today=currentBusinessDate();
        const payload=buildPayload(today);
        payload.reason='resume';
        postPayload(payload,el.contentWindow);
      }
    });
  });

  document.addEventListener('visibilitychange',()=>{
    if(
      !document.hidden &&
      state.sessionSync &&
      isPerformanceSession() &&
      Date.now()-state.lastAnySyncAt>RESUME_MIN_GAP_MS
    ){
      runSync('resume');
    }
  });

  window.addEventListener('focus',()=>{
    if(
      state.sessionSync &&
      isPerformanceSession() &&
      Date.now()-state.lastAnySyncAt>RESUME_MIN_GAP_MS
    ){
      runSync('resume');
    }
  });

  window.addEventListener('online',()=>{
    if(state.sessionSync && isPerformanceSession()){
      startRealtime();
      runSync('online');
    }
  });

  window.addEventListener('offline',()=>{
    // O timer permanece configurado e volta a funcionar quando a rede retornar.
  });

  window.LiveDashboardBridge={
    setActive,
    refresh:(reason='manual')=>refresh(null,reason),
    startSession,
    stopSession,
    getState:()=>({
      busy:state.busy,
      active:state.active,
      sessionSync:state.sessionSync,
      mounted:state.mounted,
      realtimeConnected:!!state.realtimeChannel,
      loadedMonth:state.loadedMonth,
      cachedRows:state.monthRows.length,
      lastFullSyncAt:state.lastFullSyncAt,
      lastTodaySyncAt:state.lastTodaySyncAt,
      lastAnySyncAt:state.lastAnySyncAt,
      backgroundIntervalMinutes:15
    })
  };
})();
