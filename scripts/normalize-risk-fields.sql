-- One-time cleanup: normalize legacy `risk_board_config.fields_json` OBJECT rows
-- into the current `RiskFieldConfigEntry[]` ARRAY shape.
--
-- Before the "generic field-mapping list" generalization, fields_json held a
-- fixed object of customfield ids: {flagged?, rejections?, implementor?,
-- codeReviewer?}. It now holds an array of RiskFieldConfigEntry. The column type
-- never changed (still TEXT), so there was no migration — the reader carried a
-- tolerant conversion branch instead. That branch is being removed; this script
-- does the same conversion once, up front, so no row silently reads back as [].
--
-- The mapping mirrors the old reader (store.ts fieldEntriesFromStored) exactly:
--   flagged    -> { label:'Flagged',    fieldId, kind:'flag' }
--   rejections -> { label:'Rejections', fieldId, kind:'count', warn:2, risk:4 }
--   implementor / codeReviewer -> dropped (they were display-only, too org-specific).
--
-- Safe to re-run (idempotent): once a row is an array, json_type(...) <> 'object'
-- so it is skipped. Corrupt/NULL rows are left untouched (they already read []).
--
-- Apply via:  npm run db:cleanup:risk-fields             (local)
--             npm run db:cleanup:risk-fields:remote       (production)
--
-- IMPORTANT: run the :remote form once BEFORE deploying the build that drops the
-- read-time conversion branch, or any org still on the object shape loses its
-- field metrics until an admin re-saves the Risk config.

UPDATE risk_board_config
SET fields_json = (
  SELECT json_group_array(json(entry))
  FROM (
    SELECT json_object(
             'label', 'Flagged',
             'fieldId', json_extract(risk_board_config.fields_json, '$.flagged'),
             'kind', 'flag'
           ) AS entry
    WHERE COALESCE(json_extract(risk_board_config.fields_json, '$.flagged'), '') <> ''
    UNION ALL
    SELECT json_object(
             'label', 'Rejections',
             'fieldId', json_extract(risk_board_config.fields_json, '$.rejections'),
             'kind', 'count',
             'warn', 2,
             'risk', 4
           )
    WHERE COALESCE(json_extract(risk_board_config.fields_json, '$.rejections'), '') <> ''
  )
)
WHERE json_valid(fields_json) AND json_type(fields_json) = 'object';
