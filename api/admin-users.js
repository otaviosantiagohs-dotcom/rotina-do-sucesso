const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

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
      return json(res, 403, { code: 'FORBIDDEN', message: 'Apenas Performance pode administrar usuários.' });
    }

    async function audit(eventType, entityId, newValue, oldValue = null) {
      await admin.from('audit_logs').insert({
        actor_user_id: actor.id,
        event_type: eventType,
        entity_type: 'user',
        entity_id: entityId || null,
        old_value: oldValue,
        new_value: newValue
      });
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
        const code = /already|registered|exists/i.test(msg) ? 'USERNAME_EXISTS' : 'AUTH_CREATE_FAILED';
        return json(res, 400, { code, message: msg });
      }

      const userId = created.user.id;
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

      if (profileError) {
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
          results.push({ username, ok: false, code: 'AUTH_CREATE_FAILED' });
          continue;
        }

        const userId = created.user.id;
        const { error: profileError } = await admin.from('profiles').update({
          username,
          role: 'colaborador',
          active: true,
          first_access_completed: false,
          first_name: null,
          last_name: null,
          company_id: null,
          unit_id: null
        }).eq('user_id', userId);

        if (profileError) {
          await admin.auth.admin.deleteUser(userId);
          results.push({ username, ok: false, code: 'PROFILE_CREATE_FAILED' });
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
