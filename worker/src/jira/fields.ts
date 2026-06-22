// One-time discovery of instance-specific custom field ids. The Story Points
// and Sprint fields are NEVER hardcoded — their customfield_* id varies per Jira
// instance. We discover, cache in config, and flag ambiguity rather than guess.

import type { JiraClient } from './client';

interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { custom?: string; type?: string };
}

export interface FieldDiscovery {
  storyPointsFieldId: string | null;
  sprintFieldId: string | null;
  /** Populated when >1 plausible candidate — caller should surface, not pick. */
  ambiguous: { storyPoints: string[]; sprint: string[] };
}

/** A custom field the admin can pick from in the UI (id + human name). */
export interface FieldOption {
  id: string;
  name: string;
}

/** Candidate custom fields per role, for the admin field picker. */
export interface FieldCandidates {
  storyPoints: FieldOption[];
  sprint: FieldOption[];
}

const SP_NAMES = ['story points', 'story point estimate'];
const SP_SCHEMA = 'com.pyxis.greenhopper.jira:jsw-story-points'; // common SP custom type
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';

/** Story Points / Sprint candidate fields from a /field listing (shared logic). */
function candidatesFrom(fields: JiraField[]): { storyPoints: JiraField[]; sprint: JiraField[] } {
  const spByName = fields.filter((f) => f.custom && SP_NAMES.includes(f.name.trim().toLowerCase()));
  const spBySchema = fields.filter((f) => f.schema?.custom?.includes('story-points'));
  const sprint = fields.filter((f) => f.custom && f.schema?.custom === SPRINT_SCHEMA);
  void SP_SCHEMA;
  return { storyPoints: dedupeBy([...spByName, ...spBySchema]), sprint: dedupeBy(sprint) };
}

export async function discoverFields(client: JiraClient): Promise<FieldDiscovery> {
  const fields = await client.get<JiraField[]>('/rest/api/3/field');
  const c = candidatesFrom(fields);
  const sp = c.storyPoints.map((f) => f.id);
  const sprint = c.sprint.map((f) => f.id);

  return {
    storyPointsFieldId: sp.length === 1 ? (sp[0] as string) : null,
    sprintFieldId: sprint.length === 1 ? (sprint[0] as string) : null,
    ambiguous: {
      storyPoints: sp.length > 1 ? sp : [],
      sprint: sprint.length > 1 ? sprint : [],
    },
  };
}

/**
 * Candidate Story Points / Sprint fields with names, for the admin picker. Lets
 * an admin resolve the ambiguity discovery refuses to guess (two "Story Points"
 * fields is common across Jira instances).
 */
export async function listFieldCandidates(client: JiraClient): Promise<FieldCandidates> {
  const fields = await client.get<JiraField[]>('/rest/api/3/field');
  const c = candidatesFrom(fields);
  const opt = (f: JiraField): FieldOption => ({ id: f.id, name: f.name });
  return { storyPoints: c.storyPoints.map(opt), sprint: c.sprint.map(opt) };
}

function dedupeBy(fields: JiraField[]): JiraField[] {
  const seen = new Set<string>();
  return fields.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}
