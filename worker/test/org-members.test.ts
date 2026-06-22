// The admin member-picker source: listOrgMembers returns everyone whose token
// reaches a given cloud (the org boundary), with display name, ordered by name —
// and never leaks accounts from another org.
import { beforeEach, describe, expect, it } from 'vitest';
import { Dao } from '../src/db/dao';
import { SqliteD1 } from './support/sqlite-d1';

let dao: Dao;

beforeEach(async () => {
  dao = new Dao(new SqliteD1());
  // Two members in cloud-a (Bob also reaches cloud-b), one member only in cloud-b.
  await dao.upsertUser('acct-bob', 'Bob', 'cloud-a');
  await dao.upsertSite('acct-bob', { cloudId: 'cloud-a', name: 'Acme', siteUrl: 'https://acme.atlassian.net' });
  await dao.upsertSite('acct-bob', { cloudId: 'cloud-b', name: 'Beta', siteUrl: 'https://beta.atlassian.net' });

  await dao.upsertUser('acct-alice', 'Alice', 'cloud-a');
  await dao.upsertSite('acct-alice', { cloudId: 'cloud-a', name: 'Acme', siteUrl: 'https://acme.atlassian.net' });

  await dao.upsertUser('acct-carol', 'Carol', 'cloud-b');
  await dao.upsertSite('acct-carol', { cloudId: 'cloud-b', name: 'Beta', siteUrl: 'https://beta.atlassian.net' });
});

describe('listOrgMembers', () => {
  it('returns members of the org ordered by display name', async () => {
    const members = await dao.listOrgMembers('cloud-a');
    expect(members).toEqual([
      { accountId: 'acct-alice', displayName: 'Alice' },
      { accountId: 'acct-bob', displayName: 'Bob' },
    ]);
  });

  it('scopes to the org and includes multi-site members', async () => {
    const members = await dao.listOrgMembers('cloud-b');
    expect(members.map((m) => m.accountId).sort()).toEqual(['acct-bob', 'acct-carol']);
    // Alice (cloud-a only) is not surfaced to a different org.
    expect(members.some((m) => m.accountId === 'acct-alice')).toBe(false);
  });
});
