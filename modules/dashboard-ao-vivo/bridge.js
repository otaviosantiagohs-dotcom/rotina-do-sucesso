/* Rotina de Sucesso — Dashboard Ao Vivo
   V9.5.12 — bridge via provider oficial do app.
*/
(function(){
  'use strict';

  const HEARTBEAT_MS=15*60*1000;
  const REALTIME_DEBOUNCE_MS=500;
  const RESUME_GAP_MS=15*1000;

  const state={
    active:false,
    started:false,
    busy:false,
    lastPayload:null,
    lastSyncAt:0,
    heartbeat:null,
    realtimeChannel:null,
    realtimeDebounce:null,
    pendingReason:null,
    mounted:false
  };

  const provider=()=>window.RDSLiveDataProvider||null;
  const frame=()=>document.getElementById('liveDashboardFrame');

  function mount(){
    const el=frame();
    if(!el)return null;

    if(!state.mounted){
      const src=el.dataset.src;
      if(src && !el.getAttribute('src'))el.setAttribute('src',src);
      state.mounted=true;
    }
    return el;
  }

  function post(type,data={},targetWindow=null){
    const target=targetWindow||frame()?.contentWindow;
    if(!target)return;
    target.postMessage({type,...data},window.location.origin);
  }

  function sendVisibility(){
    post('rotina-live-visibility',{active:state.active});
  }

  async function sync(reason='manual',targetWindow=null){
    const p=provider();

    if(!p?.isAvailable?.()){
      post(
        'rotina-live-error',
        {message:'Provider de dados da Dashboard Ao Vivo indisponível.'},
        targetWindow
      );
      return;
    }

    if(state.busy){
      state.pendingReason=reason;
      return;
    }

    state.busy=true;

    try{
      const payload=await p.fetchPayload(reason);

      state.lastPayload=payload;
      state.lastSyncAt=Date.now();

      post('rotina-live-data',{payload},targetWindow);

      window.dispatchEvent(new CustomEvent('rds-live-sync',{
        detail:{
          reason,
          generatedAt:payload.generatedAt,
          rowCount:payload.rowCount,
          syncMode:payload.syncMode
        }
      }));
    }catch(err){
      console.error('Dashboard Ao Vivo:',err);
      post(
        'rotina-live-error',
        {
          message:err?.message||'Falha ao consultar dados reais.',
          at:new Date().toISOString()
        },
        targetWindow
      );
    }finally{
      state.busy=false;

      if(state.pendingReason){
        const next=state.pendingReason;
        state.pendingReason=null;
        setTimeout(()=>sync(next),50);
      }
    }
  }

  function realtimeChanged(){
    clearTimeout(state.realtimeDebounce);
    state.realtimeDebounce=setTimeout(()=>{
      if(state.started)sync('realtime');
    },REALTIME_DEBOUNCE_MS);
  }

  function startHeartbeat(){
    clearInterval(state.heartbeat);
    state.heartbeat=setInterval(()=>{
      if(state.started)sync('heartbeat');
    },HEARTBEAT_MS);
  }

  function startRealtime(){
    if(state.realtimeChannel)return;

    const p=provider();
    if(!p?.subscribe)return;

    state.realtimeChannel=p.subscribe(realtimeChanged);
  }

  async function stopRealtime(){
    clearTimeout(state.realtimeDebounce);
    state.realtimeDebounce=null;

    if(state.realtimeChannel){
      try{
        await provider()?.unsubscribe?.(state.realtimeChannel);
      }catch(_){}
      state.realtimeChannel=null;
    }
  }

  function startSession(){
    if(!provider()?.isAvailable?.())return;

    if(state.started){
      sync('session-resume');
      return;
    }

    state.started=true;
    startHeartbeat();
    startRealtime();
    sync('session-start');
  }

  function stopSession(){
    state.started=false;
    state.active=false;

    if(state.heartbeat){
      clearInterval(state.heartbeat);
      state.heartbeat=null;
    }

    stopRealtime();
    state.pendingReason=null;
    sendVisibility();
  }

  function setActive(active){
    state.active=active===true;

    if(state.active){
      const el=mount();

      if(!state.started)startSession();

      sendVisibility();

      if(state.lastPayload && el?.contentWindow){
        post(
          'rotina-live-data',
          {payload:{...state.lastPayload,reason:'resume'}},
          el.contentWindow
        );
      }

      // Sempre confirma o banco ao entrar na Dashboard Ao Vivo.
      setTimeout(()=>sync('open'),0);
    }else{
      // A sincronização continua ativa em segundo plano.
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

    if(event.data?.type==='rotina-live-request'){
      const reason=['initial','auto','manual','resume'].includes(event.data.reason)
        ? event.data.reason
        : 'manual';

      sync(reason,event.source);
    }
  });

  function attachFrameLoad(){
    const el=frame();
    if(!el || el.dataset.rdsLiveBound==='1')return;

    el.dataset.rdsLiveBound='1';

    el.addEventListener('load',()=>{
      sendVisibility();

      if(state.lastPayload){
        post(
          'rotina-live-data',
          {payload:{...state.lastPayload,reason:'resume'}},
          el.contentWindow
        );
      }

      if(state.active){
        setTimeout(()=>sync('frame-load',el.contentWindow),0);
      }
    });
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',attachFrameLoad,{once:true});
  }else{
    attachFrameLoad();
  }

  document.addEventListener('visibilitychange',()=>{
    if(
      !document.hidden &&
      state.started &&
      Date.now()-state.lastSyncAt>RESUME_GAP_MS
    ){
      sync('resume');
    }
  });

  window.addEventListener('focus',()=>{
    if(
      state.started &&
      Date.now()-state.lastSyncAt>RESUME_GAP_MS
    ){
      sync('resume');
    }
  });

  window.addEventListener('online',()=>{
    if(state.started){
      startRealtime();
      sync('online');
    }
  });

  window.LiveDashboardBridge={
    setActive,
    refresh:(reason='manual')=>sync(reason),
    startSession,
    stopSession,
    getState:()=>({
      active:state.active,
      started:state.started,
      busy:state.busy,
      lastSyncAt:state.lastSyncAt,
      hasPayload:!!state.lastPayload,
      rowCount:state.lastPayload?.rowCount??null,
      syncMode:state.lastPayload?.syncMode??null,
      realtimeConnected:!!state.realtimeChannel,
      heartbeatMinutes:15
    })
  };

  // Cobre sessão restaurada antes de o bridge terminar de carregar.
  setTimeout(()=>{
    attachFrameLoad();
    if(provider()?.isAvailable?.())startSession();
  },0);
})();
