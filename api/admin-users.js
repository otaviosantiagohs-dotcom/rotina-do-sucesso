const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

function json(res, status, payload) {
  res.status(status).json(payload);
}
function technicalEmail(username) {
  return `${username.trim().toLowerCase()}@rotina.internal`;
}
function validUsername(username) {
  return /^[a-z0-9._-]{3,40}$/.test(String(username || '').trim().toLowerCase());
}
function normalizeRole(role) {
  return ['performance','gerente','colaborador'].includes(role) ? role : 'colaborador';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' });
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return json(res, 500, { code: 'SERVER_CONFIG', message: 'Variáveis do Supabase não configuradas no servidor.' });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return json(res, 401, { code: 'UNAUTHORIZED', message: 'Sessão ausente.' });

    const { data: authData, error: authError } = await admin.auth.getUser(token);
    const actor = authData?.user;
    if (authError || !actor) return json(res, 401, { code: 'UNAUTHORIZED', message: 'Sessão inválida.' });

    const { data: actorProfile, error: actorProfileError } = await admin
      .from('profiles')
      .select('user_id,username,role,active')
      .eq('user_id', actor.id)
      .single();

    if (actorProfileError || !actorProfile || !actorProfile.active) {
      return json(res, 403, { code: 'FORBIDDEN', message: 'Usuário sem acesso ativo.' });
    }

    const body = req.body || {};
    const action = String(body.action || '');

    // Estas ações pertencem ao próprio usuário autenticado e não exigem perfil Performance.
    if (action === 'getMyPendingAlerts') {
      const { data: recipientRows, error: recipientError } = await admin
        .from('admin_alert_recipients')
        .select('alert_id,viewed_at,acknowledged_at')
        .eq('user_id', actor.id)
        .is('acknowledged_at', null);

      if (recipientError) throw recipientError;

      const alertIds = [...new Set((recipientRows || []).map(r => r.alert_id).filter(Boolean))];
      if (!alertIds.length) return json(res, 200, { ok: true, alerts: [] });

      const { data: alertRows, error: alertError } = await admin
        .from('admin_alerts')
        .select('id,message,created_at,expires_at,created_by')
        .in('id', alertIds)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: true });

      if (alertError) throw alertError;

      const alerts = (alertRows || []).map(a => ({
        alertId: a.id,
        message: a.message || '',
        sender: 'Administração',
        sentAt: a.created_at || null,
        expiresAt: a.expires_at || null
      })).filter(a => a.alertId && a.message);

      return json(res, 200, { ok: true, alerts });
    }

    if (action === 'markAlertSeen') {
      const alertId = String(body.alertId || '');
      if (!alertId) return json(res, 400, { code: 'MISSING_ALERT', message: 'Alerta não informado.' });

      const now = new Date().toISOString();

      const { data: recipient, error: recipientError } = await admin
        .from('admin_alert_recipients')
        .select('alert_id,user_id,viewed_at,acknowledged_at')
        .eq('alert_id', alertId)
        .eq('user_id', actor.id)
        .maybeSingle();

      if (recipientError) throw recipientError;
      if (!recipient) return json(res, 404, { code: 'ALERT_NOT_FOUND', message: 'Alerta não encontrado para este usuário.' });

      const { data: alertRow, error: alertError } = await admin
        .from('admin_alerts')
        .select('id,expires_at')
        .eq('id', alertId)
        .maybeSingle();

      if (alertError) throw alertError;
      if (!alertRow || new Date(alertRow.expires_at).getTime() <= Date.now()) {
        return json(res, 410, { code: 'ALERT_EXPIRED', message: 'Este alerta já expirou.' });
      }

      const update = {};
      if (!recipient.viewed_at) update.viewed_at = now;
      if (body.acknowledged === true && !recipient.acknowledged_at) update.acknowledged_at = now;

      if (Object.keys(update).length) {
        const { error: updateError } = await admin
          .from('admin_alert_recipients')
          .update(update)
          .eq('alert_id', alertId)
          .eq('user_id', actor.id);
        if (updateError) throw updateError;
      }

      return json(res, 200, { ok: true });
    }

    if (actorProfile.role !== 'performance') {
      return json(res, 403, { code: 'FORBIDDEN', message: 'Apenas Administradores/Performance podem executar esta operação.' });
    }

    async function audit(eventType, entityId, newValue, oldValue = null, entityType = 'user') {
      const { error } = await admin.from('audit_logs').insert({
        actor_user_id: actor.id,
        event_type: eventType,
        entity_type: entityType,
        entity_id: entityId || null,
        old_value: oldValue,
        new_value: newValue
      });
      if (error) throw error;
    }

    async function verifyActorPassword(password) {
      const value = String(password || '');
      if (!value) {
        const err = new Error('Senha obrigatória.');
        err.code = 'PASSWORD_REQUIRED';
        throw err;
      }

      const authClient = createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY || SUPABASE_SECRET_KEY,
        {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
          }
        }
      );

      const { data, error } = await authClient.auth.signInWithPassword({
        email: technicalEmail(actorProfile.username),
        password: value
      });

      const ok = !error && data?.user?.id === actor.id;

      // IMPORTANTE:
      // signOut() sem scope usa "global" no Supabase e revoga TODAS as
      // sessões do usuário, inclusive a sessão aberta no navegador.
      // Aqui encerramos somente a sessão temporária criada para validar
      // a senha administrativa.
      if (data?.session) {
        try { await authClient.auth.signOut({ scope: 'local' }); } catch (_) {}
      }

      if (!ok) {
        const err = new Error('Senha de login incorreta.');
        err.code = 'INVALID_PASSWORD';
        throw err;
      }
    }

    async function sendRealtimeAlert(topic, payload) {
      const url = `${SUPABASE_URL}/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/admin-alert?private=true`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SECRET_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        console.error('Realtime broadcast failed', response.status, detail);
        const err = new Error('Não foi possível disparar o alerta em tempo real.');
        err.code = 'BROADCAST_FAILED';
        throw err;
      }
    }

    async function activePerformanceCount() {
      const { count } = await admin
        .from('profiles')
        .select('user_id', { count: 'exact', head: true })
        .eq('role', 'performance')
        .eq('active', true);
      return count || 0;
    }

    async function ensureOrganization(role, active, complete, companyId, unitId, exceptUserId = null) {
      if (role === 'performance') return { companyId: null, unitId: null, complete: true };

      if (role === 'gerente' && (!companyId || !unitId)) {
        const err = new Error('Gerente precisa estar vinculado a Empresa e Unidade.');
        err.code = 'ORG_REQUIRED';
        throw err;
      }

      if (complete && (!companyId || !unitId)) {
        const err = new Error('Cadastro concluído exige Empresa e Unidade.');
        err.code = 'ORG_REQUIRED';
        throw err;
      }

      if (companyId) {
        const { data: c } = await admin.from('companies').select('id,active').eq('id', companyId).maybeSingle();
        if (!c || !c.active) {
          const err = new Error('Empresa inválida ou inativa.');
          err.code = 'INVALID_COMPANY';
          throw err;
        }
      }

      if (unitId) {
        const { data: u } = await admin.from('units').select('id,company_id,active,manager_user_id').eq('id', unitId).maybeSingle();
        if (!u || !u.active || u.company_id !== companyId) {
          const err = new Error('Unidade inválida, inativa ou não pertence à empresa.');
          err.code = 'INVALID_UNIT';
          throw err;
        }
        if (role === 'gerente' && active && u.manager_user_id && u.manager_user_id !== exceptUserId) {
          const err = new Error('A unidade já possui outro Gerente/Capitão.');
          err.code = 'UNIT_HAS_MANAGER';
          throw err;
        }
      }

      return { companyId: companyId || null, unitId: unitId || null, complete: !!complete };
    }

    async function syncManager(userId, role, active, unitId) {
      // Remove vínculos anteriores deste gerente.
      await admin.from('units').update({ manager_user_id: null }).eq('manager_user_id', userId);

      if (role === 'gerente' && active && unitId) {
        const { error } = await admin.from('units').update({ manager_user_id: userId }).eq('id', unitId);
        if (error) throw error;
      }
    }


    if (action === 'create') {
      const u = body.user || {};
      const username = String(u.username || '').trim().toLowerCase();
      const password = String(u.password || '');
      const role = normalizeRole(u.role);
      const active = u.active !== false;
      let complete = !!u.firstAccessCompleted;
      let companyId = u.companyId || null;
      let unitId = u.unitId || null;

      if (!validUsername(username)) return json(res, 400, { code: 'INVALID_USERNAME', message: 'Usuário inválido.' });
      if (!/^\d{4}$/.test(password)) return json(res, 400, { code: 'INVALID_PASSWORD', message: 'Senha deve ter exatamente 4 dígitos numéricos.' });

      const { data: existing } = await admin.from('profiles').select('user_id').ilike('username', username).maybeSingle();
      if (existing) return json(res, 409, { code: 'USERNAME_EXISTS', message: 'Esse usuário já existe.' });

      try {
        const org = await ensureOrganization(role, active, complete, companyId, unitId);
        companyId = org.companyId; unitId = org.unitId; complete = org.complete;
      } catch (e) {
        return json(res, 400, { code: e.code || 'INVALID_ORG', message: e.message });
      }

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: technicalEmail(username),
        password,
        email_confirm: true,
        user_metadata: {
          username,
          first_name: String(u.firstName || '').trim(),
          last_name: String(u.lastName || '').trim()
        }
      });

      if (createError || !created?.user) {
        const msg = createError?.message || 'Não foi possível criar o usuário.';
        const code = /already|registered|exists|email_exists/i.test(msg) ? 'USERNAME_EXISTS' : 'AUTH_CREATE_FAILED';
        console.error('auth.createUser failed', {
          code: createError?.code || null,
          status: createError?.status || null,
          message: msg
        });
        return json(res, createError?.status && createError.status >= 400 ? createError.status : 400, {
          code,
          message: msg,
          authCode: createError?.code || null
        });
      }

      const userId = created.user.id;

      // O perfil deixa de depender de trigger em auth.users.
      // A API administrativa cria explicitamente o vínculo no banco.
      const { error: profileError } = await admin.from('profiles').upsert({
        user_id: userId,
        username,
        first_name: String(u.firstName || '').trim() || null,
        last_name: String(u.lastName || '').trim() || null,
        role,
        company_id: companyId,
        unit_id: unitId,
        active,
        first_access_completed: complete,
        must_change_password: true
      }, { onConflict: 'user_id' });

      if (profileError) {
        console.error('profiles.upsert failed after auth.createUser', profileError);
        await admin.auth.admin.deleteUser(userId);
        return json(res, 400, { code: 'PROFILE_CREATE_FAILED', message: profileError.message });
      }

      await syncManager(userId, role, active, unitId);
      await audit('USUARIO_CRIADO', username, JSON.stringify({ role, active, companyId, unitId, firstAccessCompleted: complete, mustChangePassword: true }));
      return json(res, 200, { ok: true, userId });
    }

    if (action === 'update') {
      const userId = String(body.userId || '');
      const u = body.user || {};
      if (!userId) return json(res, 400, { code: 'MISSING_USER', message: 'Usuário não informado.' });

      const { data: oldProfile } = await admin.from('profiles').select('*').eq('user_id', userId).maybeSingle();
      if (!oldProfile) return json(res, 404, { code: 'USER_NOT_FOUND', message: 'Usuário não encontrado.' });

      const username = String(u.username || '').trim().toLowerCase();
      const role = normalizeRole(u.role);
      const active = u.active !== false;
      let complete = !!u.firstAccessCompleted;
      let companyId = u.companyId || null;
      let unitId = u.unitId || null;

      if (!validUsername(username)) return json(res, 400, { code: 'INVALID_USERNAME', message: 'Usuário inválido.' });
      if (u.password && !/^\d{4}$/.test(String(u.password))) return json(res, 400, { code: 'INVALID_PASSWORD', message: 'A nova senha precisa ter exatamente 4 dígitos numéricos.' });

      if (userId === actor.id && (!active || role !== 'performance')) {
        return json(res, 400, { code: 'SELF_LOCKOUT', message: 'Não é possível retirar o próprio acesso de Performance.' });
      }

      if (oldProfile.role === 'performance' && oldProfile.active && (role !== 'performance' || !active)) {
        if ((await activePerformanceCount()) <= 1) {
          return json(res, 400, { code: 'LAST_PERFORMANCE', message: 'É necessário manter pelo menos um Performance ativo.' });
        }
      }

      const { data: duplicate } = await admin.from('profiles').select('user_id').ilike('username', username).neq('user_id', userId).maybeSingle();
      if (duplicate) return json(res, 409, { code: 'USERNAME_EXISTS', message: 'Esse usuário já existe.' });

      try {
        const org = await ensureOrganization(role, active, complete, companyId, unitId, userId);
        companyId = org.companyId; unitId = org.unitId; complete = org.complete;
      } catch (e) {
        return json(res, 400, { code: e.code || 'INVALID_ORG', message: e.message });
      }

      const authUpdate = {
        email: technicalEmail(username),
        user_metadata: {
          username,
          first_name: String(u.firstName || '').trim(),
          last_name: String(u.lastName || '').trim()
        }
      };
      if (u.password) authUpdate.password = String(u.password);

      const { error: authUpdateError } = await admin.auth.admin.updateUserById(userId, authUpdate);
      if (authUpdateError) return json(res, 400, { code: 'AUTH_UPDATE_FAILED', message: authUpdateError.message });

      const profilePatch = {
        username,
        first_name: String(u.firstName || '').trim() || null,
        last_name: String(u.lastName || '').trim() || null,
        role,
        company_id: companyId,
        unit_id: unitId,
        active,
        first_access_completed: complete
      };

      // Se um Administrador redefinir a senha de um usuário,
      // essa senha volta a ser temporária.
      if (u.password) profilePatch.must_change_password = true;

      const { error: profileError } = await admin.from('profiles').update(profilePatch).eq('user_id', userId);

      if (profileError) return json(res, 400, { code: 'PROFILE_UPDATE_FAILED', message: profileError.message });

      await syncManager(userId, role, active, unitId);
      await audit('USUARIO_EDITADO', username, JSON.stringify({ role, active, companyId, unitId, firstAccessCompleted: complete, passwordResetRequiresChange: !!u.password }), JSON.stringify({
        role: oldProfile.role, active: oldProfile.active, companyId: oldProfile.company_id, unitId: oldProfile.unit_id
      }));
      return json(res, 200, { ok: true });
    }

    if (action === 'toggle') {
      const userId = String(body.userId || '');
      const active = !!body.active;
      if (!userId) return json(res, 400, { code: 'MISSING_USER', message: 'Usuário não informado.' });
      if (userId === actor.id && !active) return json(res, 400, { code: 'SELF_LOCKOUT', message: 'Não é possível inativar o próprio usuário.' });

      const { data: profile } = await admin.from('profiles').select('*').eq('user_id', userId).maybeSingle();
      if (!profile) return json(res, 404, { code: 'USER_NOT_FOUND', message: 'Usuário não encontrado.' });

      if (profile.role === 'performance' && profile.active && !active && (await activePerformanceCount()) <= 1) {
        return json(res, 400, { code: 'LAST_PERFORMANCE', message: 'É necessário manter pelo menos um Performance ativo.' });
      }

      const { error } = await admin.from('profiles').update({ active }).eq('user_id', userId);
      if (error) return json(res, 400, { code: 'PROFILE_UPDATE_FAILED', message: error.message });

      if (!active && profile.role === 'gerente') {
        await admin.from('units').update({ manager_user_id: null }).eq('manager_user_id', userId);
      }
      if (active && profile.role === 'gerente' && profile.unit_id) {
        const { data: unit } = await admin.from('units').select('manager_user_id').eq('id', profile.unit_id).maybeSingle();
        if (unit?.manager_user_id && unit.manager_user_id !== userId) {
          await admin.from('profiles').update({ active: false }).eq('user_id', userId);
          return json(res, 409, { code: 'UNIT_HAS_MANAGER', message: 'A unidade já possui outro Gerente/Capitão.' });
        }
        await admin.from('units').update({ manager_user_id: userId }).eq('id', profile.unit_id);
      }

      await audit(active ? 'USUARIO_ATIVADO' : 'USUARIO_INATIVADO', profile.username, JSON.stringify({ active }));
      return json(res, 200, { ok: true });
    }


    if (action === 'deleteUser') {
      const userId = String(body.userId || '');
      if (!userId) return json(res, 400, { code: 'MISSING_USER', message: 'Usuário não informado.' });
      if (userId === actor.id) return json(res, 400, { code: 'SELF_DELETE', message: 'Não é possível excluir o usuário que está logado.' });

      try {
        await verifyActorPassword(body.password);
      } catch (e) {
        return json(res, 401, { code: e.code || 'INVALID_PASSWORD', message: e.message });
      }

      const { data: profile } = await admin.from('profiles').select('*').eq('user_id', userId).maybeSingle();
      if (!profile) return json(res, 404, { code: 'USER_NOT_FOUND', message: 'Usuário não encontrado.' });

      if (profile.role === 'performance' && profile.active && (await activePerformanceCount()) <= 1) {
        return json(res, 400, { code: 'LAST_PERFORMANCE', message: 'É necessário manter pelo menos um Performance ativo.' });
      }

      const { count: routineCount } = await admin
        .from('daily_routines')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

      const details = JSON.stringify({
        username: profile.username,
        role: profile.role,
        companyId: profile.company_id,
        unitId: profile.unit_id,
        routinesRemoved: routineCount || 0,
        passwordRevalidated: true
      });

      await audit('USUARIO_EXCLUSAO_AUTORIZADA', profile.username, details);

      try {
        await admin.from('units').update({ manager_user_id: null }).eq('manager_user_id', userId);

        const { error: routinesError } = await admin.from('daily_routines').delete().eq('user_id', userId);
        if (routinesError) throw routinesError;

        const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
        if (deleteError) throw deleteError;

        await audit('USUARIO_EXCLUIDO', profile.username, details);
        return json(res, 200, { ok: true });
      } catch (e) {
        try {
          await audit('USUARIO_EXCLUSAO_FALHOU', profile.username, JSON.stringify({ message: e.message }));
        } catch (_) {}
        throw e;
      }
    }

    if (action === 'deleteUnit') {
      const unitId = String(body.unitId || '');
      if (!unitId) return json(res, 400, { code: 'MISSING_UNIT', message: 'Unidade não informada.' });

      try {
        await verifyActorPassword(body.password);
      } catch (e) {
        return json(res, 401, { code: e.code || 'INVALID_PASSWORD', message: e.message });
      }

      const { data: unit } = await admin
        .from('units')
        .select('id,company_id,name,short_code,manager_user_id,active')
        .eq('id', unitId)
        .maybeSingle();

      if (!unit) return json(res, 404, { code: 'UNIT_NOT_FOUND', message: 'Unidade não encontrada.' });

      const { count: linkedUsers } = await admin
        .from('profiles')
        .select('user_id', { count: 'exact', head: true })
        .eq('unit_id', unitId);

      if ((linkedUsers || 0) > 0) {
        return json(res, 409, {
          code: 'UNIT_HAS_LINKED_USERS',
          message: 'A unidade possui usuários vinculados. Transfira ou exclua esses usuários primeiro.'
        });
      }

      const { count: routineCount } = await admin
        .from('daily_routines')
        .select('id', { count: 'exact', head: true })
        .eq('unit_id', unitId);

      const details = JSON.stringify({
        name: unit.name,
        companyId: unit.company_id,
        routinesRemoved: routineCount || 0,
        passwordRevalidated: true
      });

      await audit('UNIDADE_EXCLUSAO_AUTORIZADA', unit.name, details, null, 'unit');

      try {
        const { error: routinesError } = await admin.from('daily_routines').delete().eq('unit_id', unitId);
        if (routinesError) throw routinesError;

        const { error: unitError } = await admin.from('units').delete().eq('id', unitId);
        if (unitError) throw unitError;

        await audit('UNIDADE_EXCLUIDA', unit.name, details, null, 'unit');
        return json(res, 200, { ok: true });
      } catch (e) {
        try {
          await audit('UNIDADE_EXCLUSAO_FALHOU', unit.name, JSON.stringify({ message: e.message }), null, 'unit');
        } catch (_) {}
        throw e;
      }
    }

    if (action === 'broadcastMessage') {
      const message = String(body.message || '').trim();
      const audience = body.audience === 'specific' ? 'specific' : 'all';

      if (!message) return json(res, 400, { code: 'EMPTY_MESSAGE', message: 'Digite a mensagem do alerta.' });
      if (message.length > 1000) return json(res, 400, { code: 'MESSAGE_TOO_LONG', message: 'O alerta pode ter no máximo 1.000 caracteres.' });

      let recipients = [];

      if (audience === 'all') {
        const { data, error } = await admin
          .from('profiles')
          .select('user_id')
          .eq('active', true);
        if (error) throw error;
        recipients = data || [];
      } else {
        const requested = Array.isArray(body.userIds)
          ? [...new Set(body.userIds.map(String))].slice(0, 500)
          : [];

        if (!requested.length) {
          return json(res, 400, { code: 'NO_RECIPIENTS', message: 'Selecione pelo menos um usuário.' });
        }

        const { data, error } = await admin
          .from('profiles')
          .select('user_id')
          .in('user_id', requested)
          .eq('active', true);

        if (error) throw error;
        recipients = data || [];
      }

      const ids = [...new Set(recipients.map(x => x.user_id).filter(Boolean))];
      if (!ids.length) {
        return json(res, 400, { code: 'NO_ACTIVE_RECIPIENTS', message: 'Nenhum destinatário ativo foi encontrado.' });
      }

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const { data: createdAlert, error: alertError } = await admin
        .from('admin_alerts')
        .insert({
          created_by: actor.id,
          message,
          audience,
          target_count: ids.length,
          expires_at: expiresAt
        })
        .select('id,created_at,expires_at')
        .single();

      if (alertError) throw alertError;

      const recipientRows = ids.map(userId => ({
        alert_id: createdAlert.id,
        user_id: userId
      }));

      const { error: recipientInsertError } = await admin
        .from('admin_alert_recipients')
        .insert(recipientRows);

      if (recipientInsertError) {
        await admin.from('admin_alerts').delete().eq('id', createdAlert.id);
        throw recipientInsertError;
      }

      const payload = {
        alertId: createdAlert.id,
        message,
        sender: actorProfile.username || 'Administração',
        sentAt: createdAlert.created_at,
        expiresAt: createdAlert.expires_at
      };

      let realtimeFailures = 0;

      if (audience === 'all') {
        try {
          await sendRealtimeAlert('rds-alerts-all', payload);
        } catch (e) {
          console.error(e);
          realtimeFailures = ids.length;
        }
      } else {
        const results = await Promise.allSettled(
          ids.map(id => sendRealtimeAlert(`rds-alerts-user-${id}`, payload))
        );
        realtimeFailures = results.filter(r => r.status === 'rejected').length;
      }

      return json(res, 200, {
        ok: true,
        alertId: createdAlert.id,
        targets: ids.length,
        realtimeFailures,
        expiresAt: createdAlert.expires_at
      });
    }

    if (action === 'listAlertViews') {
      const now = new Date().toISOString();

      const { data: alerts, error: alertsError } = await admin
        .from('admin_alerts')
        .select('id,message,audience,target_count,created_at,expires_at,created_by')
        .gt('expires_at', now)
        .order('created_at', { ascending: false })
        .limit(100);

      if (alertsError) throw alertsError;
      if (!(alerts || []).length) return json(res, 200, { ok: true, alerts: [] });

      const alertIds = alerts.map(a => a.id);

      const { data: recipientRows, error: recipientsError } = await admin
        .from('admin_alert_recipients')
        .select('alert_id,user_id,viewed_at,acknowledged_at')
        .in('alert_id', alertIds);

      if (recipientsError) throw recipientsError;

      const userIds = [...new Set((recipientRows || []).map(r => r.user_id).filter(Boolean))];
      let profiles = [];

      if (userIds.length) {
        const { data, error } = await admin
          .from('profiles')
          .select('user_id,username,first_name,last_name,unit_id')
          .in('user_id', userIds);
        if (error) throw error;
        profiles = data || [];
      }

      const profileMap = new Map(profiles.map(p => [p.user_id, p]));

      const output = alerts.map(a => ({
        id: a.id,
        message: a.message,
        audience: a.audience,
        audience_label: a.audience === 'all' ? 'Todos os usuários ativos' : 'Usuários específicos',
        target_count: a.target_count,
        created_at: a.created_at,
        expires_at: a.expires_at,
        recipients: (recipientRows || [])
          .filter(r => r.alert_id === a.id)
          .map(r => {
            const p = profileMap.get(r.user_id) || {};
            return {
              user_id: r.user_id,
              username: p.username || '',
              name: [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.username || 'Usuário',
              unit_id: p.unit_id || null,
              viewed_at: r.viewed_at,
              acknowledged_at: r.acknowledged_at
            };
          })
          .sort((x, y) => String(x.name).localeCompare(String(y.name), 'pt-BR'))
      }));

      return json(res, 200, { ok: true, alerts: output });
    }

    if (action === 'bulkCreate') {
      const items = Array.isArray(body.users) ? body.users.slice(0, 200) : [];
      if (!items.length) return json(res, 400, { code: 'EMPTY_IMPORT', message: 'Nenhum usuário para importar.' });

      const results = [];
      let createdCount = 0;

      for (const item of items) {
        const username = String(item.username || '').trim().toLowerCase();
        const password = String(item.password || '');

        if (!validUsername(username) || !/^\d{4}$/.test(password)) {
          results.push({ username, ok: false, code: 'INVALID_DATA' });
          continue;
        }

        const { data: exists } = await admin.from('profiles').select('user_id').ilike('username', username).maybeSingle();
        if (exists) {
          results.push({ username, ok: false, code: 'USERNAME_EXISTS' });
          continue;
        }

        const { data: created, error } = await admin.auth.admin.createUser({
          email: technicalEmail(username),
          password,
          email_confirm: true,
          user_metadata: { username }
        });

        if (error || !created?.user) {
          console.error('auth.createUser failed in bulkCreate', {
            username,
            code: error?.code || null,
            status: error?.status || null,
            message: error?.message || null
          });
          results.push({
            username,
            ok: false,
            code: /already|registered|exists|email_exists/i.test(error?.message || '') ? 'USERNAME_EXISTS' : 'AUTH_CREATE_FAILED',
            message: error?.message || 'Falha ao criar usuário no Supabase Auth.'
          });
          continue;
        }

        const userId = created.user.id;
        const { error: profileError } = await admin.from('profiles').upsert({
          user_id: userId,
          username,
          role: 'colaborador',
          active: true,
          first_access_completed: false,
          must_change_password: true,
          first_name: null,
          last_name: null,
          company_id: null,
          unit_id: null
        }, { onConflict: 'user_id' });

        if (profileError) {
          console.error('profiles.upsert failed in bulkCreate', profileError);
          await admin.auth.admin.deleteUser(userId);
          results.push({ username, ok: false, code: 'PROFILE_CREATE_FAILED', message: profileError.message });
          continue;
        }

        createdCount++;
        results.push({ username, ok: true, userId });
      }

      await audit('USUARIOS_IMPORTADOS', 'bulk', JSON.stringify({ requested: items.length, created: createdCount }));
      return json(res, 200, { ok: true, created: createdCount, results });
    }

    return json(res, 400, { code: 'INVALID_ACTION', message: 'Ação administrativa inválida.' });

  } catch (err) {
    console.error('admin-users error', err);
    return json(res, 500, { code: 'SERVER_ERROR', message: 'Falha interna ao administrar usuários.' });
  }
};
