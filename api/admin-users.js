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

    if (actorProfileError || !actorProfile || !actorProfile.active || actorProfile.role !== 'performance') {
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
        { auth: { autoRefreshToken: false, persistSession: false } }
      );

      const { data, error } = await authClient.auth.signInWithPassword({
        email: technicalEmail(actorProfile.username),
        password: value
      });

      const ok = !error && data?.user?.id === actor.id;
      try { await authClient.auth.signOut(); } catch (_) {}

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

    const body = req.body || {};
    const action = body.action;

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
      if (password.length < 6) return json(res, 400, { code: 'INVALID_PASSWORD', message: 'Senha deve ter pelo menos 6 caracteres.' });

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
        first_access_completed: complete
      }, { onConflict: 'user_id' });

      if (profileError) {
        console.error('profiles.upsert failed after auth.createUser', profileError);
        await admin.auth.admin.deleteUser(userId);
        return json(res, 400, { code: 'PROFILE_CREATE_FAILED', message: profileError.message });
      }

      await syncManager(userId, role, active, unitId);
      await audit('USUARIO_CRIADO', username, JSON.stringify({ role, active, companyId, unitId, firstAccessCompleted: complete }));
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
      if (u.password && String(u.password).length < 6) return json(res, 400, { code: 'INVALID_PASSWORD', message: 'A nova senha precisa ter pelo menos 6 caracteres.' });

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

      const { error: profileError } = await admin.from('profiles').update({
        username,
        first_name: String(u.firstName || '').trim() || null,
        last_name: String(u.lastName || '').trim() || null,
        role,
        company_id: companyId,
        unit_id: unitId,
        active,
        first_access_completed: complete
      }).eq('user_id', userId);

      if (profileError) return json(res, 400, { code: 'PROFILE_UPDATE_FAILED', message: profileError.message });

      await syncManager(userId, role, active, unitId);
      await audit('USUARIO_EDITADO', username, JSON.stringify({ role, active, companyId, unitId, firstAccessCompleted: complete }), JSON.stringify({
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

      const payload = {
        message,
        sender: actorProfile.username || 'Administração',
        sentAt: new Date().toISOString()
      };

      if (audience === 'all') {
        await sendRealtimeAlert('rds-alerts-all', payload);
        return json(res, 200, { ok: true, targets: 1 });
      }

      const requested = Array.isArray(body.userIds) ? [...new Set(body.userIds.map(String))].slice(0, 200) : [];
      if (!requested.length) return json(res, 400, { code: 'NO_RECIPIENTS', message: 'Selecione pelo menos um usuário.' });

      const { data: recipients, error: recipientsError } = await admin
        .from('profiles')
        .select('user_id')
        .in('user_id', requested)
        .eq('active', true);

      if (recipientsError) throw recipientsError;
      const ids = (recipients || []).map(x => x.user_id);

      await Promise.all(
        ids.map(id => sendRealtimeAlert(`rds-alerts-user-${id}`, payload))
      );

      return json(res, 200, { ok: true, targets: ids.length });
    }

    if (action === 'bulkCreate') {
      const items = Array.isArray(body.users) ? body.users.slice(0, 200) : [];
      if (!items.length) return json(res, 400, { code: 'EMPTY_IMPORT', message: 'Nenhum usuário para importar.' });

      const results = [];
      let createdCount = 0;

      for (const item of items) {
        const username = String(item.username || '').trim().toLowerCase();
        const password = String(item.password || '');

        if (!validUsername(username) || password.length < 6) {
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
