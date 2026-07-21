// Admin-only writes. Every handler here is gated by requireAdmin() in the
// router. Guards: cannot revoke the last admin; cannot self-revoke when sole
// admin. The BOOTSTRAP_ADMIN_ACCOUNT_ID env is a permanent recovery hatch and is
// always treated as admin regardless of DB state (see http.requireAdmin).

import type {
  AppointAdminRequest,
  AssignMembershipRequest,
  ConfigResponse,
  CreateTeamRequest,
  DoneStatusConfigRequest,
  FieldCandidatesResponse,
  OrgMembersResponse,
  SetFieldsRequest,
  Team,
  TeamMembership,
} from '@shared/contracts';
import type {
  AdminChannelConfigItem,
  AdminChannelConfigResponse,
  ConfigureChannelRequest,
} from '@shared/notifications';
import { type AuthedCtx, error, json, readJson } from '../http';
import { JiraClient } from '../jira/client';
import { listFieldCandidates } from '../jira/fields';
import { errFields, log } from '../log';
import { availableChannels, resolve } from '../notifications/registry';

export async function createTeam(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<CreateTeamRequest>(req);
  if (!body?.name?.trim() || !body.cloudId) return error(400, 'name and cloudId required');
  const teamId = await ctx.dao.createTeam(body.cloudId, body.name.trim());
  const team: Team = { teamId, cloudId: body.cloudId, name: body.name.trim() };
  return json(team, { status: 201 });
}

export async function listTeams(ctx: AuthedCtx): Promise<Response> {
  const teams = await ctx.dao.listTeams(ctx.cloudId);
  return json({ teams } satisfies { teams: Team[] });
}

export async function listOrgMembers(ctx: AuthedCtx): Promise<Response> {
  const members = await ctx.dao.listOrgMembers(ctx.cloudId);
  return json({ members } satisfies OrgMembersResponse);
}

export async function listMemberships(ctx: AuthedCtx, teamId: string): Promise<Response> {
  const rows = await ctx.dao.listMemberships(teamId);
  const members: TeamMembership[] = [];
  for (const r of rows) {
    members.push({
      accountId: r.accountId,
      displayName: await ctx.dao.getDisplayName(r.accountId),
      teamId,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
    });
  }
  return json({ members });
}

export async function assignMembership(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<AssignMembershipRequest>(req);
  if (!body?.accountId || !body.teamId) return error(400, 'accountId and teamId required');
  await ctx.dao.assignMembership(
    body.accountId,
    body.teamId,
    body.effectiveFrom, // optional; dao defaults to now and closes prior membership
  );
  return json({ ok: true });
}

export async function appointAdmin(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<AppointAdminRequest>(req);
  if (!body?.accountId) return error(400, 'accountId required');
  await ctx.dao.appointAdmin(body.accountId, ctx.accountId);
  return json({ ok: true });
}

export async function revokeAdmin(ctx: AuthedCtx, targetAccountId: string): Promise<Response> {
  // Guard: never strand the org without an admin.
  const total = await ctx.dao.countAdmins();
  const isTargetAdmin = await ctx.dao.isAdmin(targetAccountId);
  if (isTargetAdmin && total <= 1) {
    return error(409, 'cannot revoke the last remaining admin', 'LAST_ADMIN');
  }
  if (targetAccountId === ctx.accountId && total <= 1) {
    return error(409, 'cannot self-revoke as the sole admin', 'SOLE_ADMIN_SELF');
  }
  await ctx.dao.revokeAdmin(targetAccountId);
  return json({ ok: true });
}

export async function setDoneStatuses(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<DoneStatusConfigRequest>(req);
  if (!body?.cloudId || !Array.isArray(body.doneStatusNames)) {
    return error(400, 'cloudId and doneStatusNames[] required');
  }
  await ctx.dao.setDoneStatusNames(body.cloudId, body.doneStatusNames);
  return json({ ok: true });
}

export async function getConfig(ctx: AuthedCtx): Promise<Response> {
  const c = await ctx.dao.getConfig(ctx.cloudId);
  const body: ConfigResponse = {
    cloudId: c.cloudId,
    storyPointsFieldId: c.storyPointsFieldId,
    sprintFieldId: c.sprintFieldId,
    doneStatusNames: c.doneStatusNames,
  };
  return json(body);
}

/** Candidate Story Points / Sprint custom fields (id + name) for the picker,
 *  plus the currently-configured ids. Hits Jira live with the admin's token. */
export async function listFields(ctx: AuthedCtx): Promise<Response> {
  const token = await ctx.dao.getToken(ctx.accountId);
  if (!token) return error(409, 'no Jira grant for this admin', 'NO_GRANT');
  const client = new JiraClient(ctx.env, ctx.dao, token, ctx.cloudId);
  const candidates = await listFieldCandidates(client);
  const config = await ctx.dao.getConfig(ctx.cloudId);
  const body: FieldCandidatesResponse = {
    storyPoints: candidates.storyPoints,
    sprint: candidates.sprint,
    current: {
      storyPointsFieldId: config.storyPointsFieldId,
      sprintFieldId: config.sprintFieldId,
    },
  };
  return json(body);
}

/** Persist the admin's chosen Story Points + Sprint field ids. Once set, the
 *  poller stops re-discovering (it only discovers while either id is null). */
export async function setFields(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<SetFieldsRequest>(req);
  if (!body?.cloudId || !body.storyPointsFieldId || !body.sprintFieldId) {
    return error(400, 'cloudId, storyPointsFieldId and sprintFieldId required');
  }
  await ctx.dao.setFieldIds(body.cloudId, body.storyPointsFieldId, body.sprintFieldId);
  return json({ ok: true });
}

/** GET /api/admin/notifications/channels — the channels that take per-org config,
 *  with the ADMIN'S org's configured state. Vendor-agnostic: the descriptor's
 *  `requestedFields` drive the admin UI. Write-only — stored secret values are
 *  never returned, only a configured boolean. */
export async function listChannelConfigs(ctx: AuthedCtx): Promise<Response> {
  const channels: AdminChannelConfigItem[] = [];
  for (const channel of availableChannels()) {
    const adapter = resolve(ctx.env, channel);
    if (!adapter?.configureOrg) continue; // channels with no per-org provisioning
    try {
      const descriptor = await adapter.describe();
      if (!descriptor.requestedFields?.length) continue;
      const configured = (await adapter.isConfigured?.(ctx.cloudId)) === true;
      // Non-secret audit echo (when/who/which site). The adapter decides what is
      // public — `summary` is an explicit allow-list, never the sealed box.
      const meta = (await adapter.orgConfigSummary?.(ctx.cloudId)) ?? null;
      const item: AdminChannelConfigItem = { descriptor, configured };
      if (meta) {
        // exactOptionalPropertyTypes: omit the key rather than set undefined.
        item.configuredAt = meta.configuredAt;
        if (meta.configuredBy) item.configuredBy = meta.configuredBy;
        item.summary = meta.summary;
      }
      channels.push(item);
    } catch (e) {
      // Same posture as routes/notifications.ts: one adapter whose table isn't
      // migrated yet must not blank the whole admin panel.
      log.warn('listChannelConfigs: adapter unavailable, skipping', {
        channel,
        ...errFields(e),
      });
    }
  }
  return json({ channels } satisfies AdminChannelConfigResponse);
}

/** PUT /api/admin/notifications/:channel/config — forward the admin-entered
 *  fields to the adapter, which validates them live against its vendor before
 *  persisting (encrypted). The adapter's human-readable error surfaces as a 400. */
export async function configureChannel(
  req: Request,
  ctx: AuthedCtx,
  channel: string,
): Promise<Response> {
  const adapter = resolve(ctx.env, channel);
  if (!adapter?.configureOrg) return error(404, 'unknown channel');
  const body = await readJson<ConfigureChannelRequest>(req);
  const fields = body && typeof body.fields === 'object' && body.fields ? body.fields : {};
  const r = await adapter.configureOrg(ctx.cloudId, fields, ctx.accountId);
  if (!r.ok) return error(400, r.error);
  return json({ ok: true });
}

/** DELETE /api/admin/notifications/:channel/config — turn a channel off for THIS
 *  site: drop the org's provisioning. Scoped to ctx.cloudId, so one site's admin
 *  can never unconfigure another's. Per-user identities are left alone — the
 *  channel simply stops being advertised until it's configured again. */
export async function unconfigureChannel(ctx: AuthedCtx, channel: string): Promise<Response> {
  const adapter = resolve(ctx.env, channel);
  if (!adapter?.unconfigureOrg) return error(404, 'unknown channel');
  await adapter.unconfigureOrg(ctx.cloudId);
  return json({ ok: true });
}
