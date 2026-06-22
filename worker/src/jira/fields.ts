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

const SP_NAMES = ['story points', 'story point estimate'];
const SP_SCHEMA = 'com.pyxis.greenhopper.jira:jsw-story-points'; // common SP custom type
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';

export async function discoverFields(client: JiraClient): Promise<FieldDiscovery> {
  const fields = await client.get<JiraField[]>('/rest/api/3/field');

  const spByName = fields.filter((f) => f.custom && SP_NAMES.includes(f.name.trim().toLowerCase()));
  const spBySchema = fields.filter((f) => f.schema?.custom?.includes('story-points'));
  const spCandidates = dedupe([...spByName, ...spBySchema].map((f) => f.id));

  const sprintCandidates = dedupe(
    fields.filter((f) => f.custom && f.schema?.custom === SPRINT_SCHEMA).map((f) => f.id),
  );
  void SP_SCHEMA;

  return {
    storyPointsFieldId: spCandidates.length === 1 ? (spCandidates[0] as string) : null,
    sprintFieldId: sprintCandidates.length === 1 ? (sprintCandidates[0] as string) : null,
    ambiguous: {
      storyPoints: spCandidates.length > 1 ? spCandidates : [],
      sprint: sprintCandidates.length > 1 ? sprintCandidates : [],
    },
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
