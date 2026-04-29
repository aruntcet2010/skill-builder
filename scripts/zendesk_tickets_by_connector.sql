-- Fetch all Zendesk tickets for a given connector with custom fields and comments.
-- Parameter 1: connector_value — the Snowflake custom-field value for the connector.
-- Parameter 2: months        — negative integer, e.g. -6 for last 6 months.
--
-- Zendesk custom field IDs (from Hevo's Zendesk instance):
--   6344831219737  = connector type selector
--   8415300134041  = severity
--   6343868668825  = conversation type
--   50074936676377 = issue category
--   50074879465497 = component
--   50074947488025 = root cause
--   47413191760665 = issue description
--   50102567398169 = resolution description
--   8946648806809  = root cause description
--   47413236731161 = RCA summary
--   47411959319193 = resolution category
--   47408148433561 = occurrence
--   7794536184217  = pipeline number
--   7716967315353  = JIRA key
--   50122158546201 = customer symptom area
--   50122226972313 = customer symptom reported

WITH target_tickets AS (
    SELECT t.ID
    FROM HEVO_ANALYTICS.RAW.RAW_ZD_TICKETS t,
         LATERAL FLATTEN(input => t.CUSTOM_FIELDS) f
    LEFT JOIN HEVO_ANALYTICS.RAW.RAW_ZD_USERS req ON t.REQUESTER_ID = req.ID
    WHERE f.value['id']::NUMBER = 6344831219737       -- connector type selector
      AND f.value['value']::VARCHAR = %(connector_value)s
      AND t.STATUS != 'deleted'
      -- Exclude Hevo-internal tickets (staff raising tickets against their own system)
      AND LOWER(SPLIT_PART(COALESCE(req.EMAIL, ''), '@', 2)) NOT LIKE '%hevo%'
      -- Exclude automated alert tickets via Zendesk tags (more reliable than subject matching)
      AND NOT (
            ARRAY_CONTAINS('internal_alert'::VARIANT, t.TAGS)
            OR ARRAY_CONTAINS('proactive_alert'::VARIANT, t.TAGS)
      )
),

custom_field_values AS (
    SELECT t.ID AS ticket_id,
           MAX(CASE WHEN f.value['id']::NUMBER = 8415300134041  THEN f.value['value']::VARCHAR END) AS severity,
           MAX(CASE WHEN f.value['id']::NUMBER = 6343868668825  THEN f.value['value']::VARCHAR END) AS conversation_type,
           MAX(CASE WHEN f.value['id']::NUMBER = 50074936676377 THEN f.value['value']::VARCHAR END) AS issue_category,
           MAX(CASE WHEN f.value['id']::NUMBER = 50074879465497 THEN f.value['value']::VARCHAR END) AS component,
           MAX(CASE WHEN f.value['id']::NUMBER = 50074947488025 THEN f.value['value']::VARCHAR END) AS root_cause,
           MAX(CASE WHEN f.value['id']::NUMBER = 47413191760665 THEN f.value['value']::VARCHAR END) AS issue_description,
           MAX(CASE WHEN f.value['id']::NUMBER = 50102567398169 THEN f.value['value']::VARCHAR END) AS resolution_description,
           MAX(CASE WHEN f.value['id']::NUMBER = 8946648806809  THEN f.value['value']::VARCHAR END) AS root_cause_description,
           MAX(CASE WHEN f.value['id']::NUMBER = 47413236731161 THEN f.value['value']::VARCHAR END) AS rca_summary,
           MAX(CASE WHEN f.value['id']::NUMBER = 47411959319193 THEN f.value['value']::VARCHAR END) AS resolution_category,
           MAX(CASE WHEN f.value['id']::NUMBER = 47408148433561 THEN f.value['value']::VARCHAR END) AS occurrence,
           MAX(CASE WHEN f.value['id']::NUMBER = 7794536184217  THEN f.value['value']::VARCHAR END) AS pipeline_number,
           MAX(CASE WHEN f.value['id']::NUMBER = 7716967315353  THEN f.value['value']::VARCHAR END) AS jira_key,
           MAX(CASE WHEN f.value['id']::NUMBER = 50122158546201 THEN f.value['value']::VARCHAR END) AS customer_symptom_area,
           MAX(CASE WHEN f.value['id']::NUMBER = 50122226972313 THEN f.value['value']::VARCHAR END) AS customer_symptom_reported
    FROM HEVO_ANALYTICS.RAW.RAW_ZD_TICKETS t,
         LATERAL FLATTEN(input => t.CUSTOM_FIELDS) f
    WHERE t.ID IN (SELECT ID FROM target_tickets)
    GROUP BY t.ID
),

ticket_comments AS (
    SELECT c.TICKET_ID,
           ARRAY_AGG(
               OBJECT_CONSTRUCT(
                   'comment_id',  c.ID::VARCHAR,
                   'author_name', u.NAME,
                   'is_agent',    IFF(u.ROLE IN ('agent', 'admin'), TRUE, FALSE),
                   'is_public',   c.PUBLIC,
                   'created_at',  c.CREATED_AT,
                   'body_text',   COALESCE(c.PLAIN_BODY, c.HTML_BODY, c.BODY)
               )
           ) WITHIN GROUP (ORDER BY c.CREATED_AT ASC) AS comments_json,
           COUNT(*) AS comment_count
    FROM HEVO_ANALYTICS.RAW.RAW_ZD_COMMENTS c
    LEFT JOIN HEVO_ANALYTICS.RAW.RAW_ZD_USERS u ON c.AUTHOR_ID = u.ID
    WHERE c.TICKET_ID IN (SELECT ID FROM target_tickets)
    GROUP BY c.TICKET_ID
)

SELECT
    t.ID AS ticket_id,
    t.SUBJECT AS ticket_title,
    t.STATUS AS ticket_status,
    t.PRIORITY AS ticket_priority,
    t.CREATED_AT AS ticket_created_at,
    t.UPDATED_AT AS ticket_updated_at,
    tm.SOLVED_AT AS ticket_solved_at,
    COALESCE(tm.REOPENS, 0) AS reopen_count,
    u_req.NAME AS requester_name,
    u_asg.NAME AS assignee_name,
    org.NAME AS organization_name,
    t.DESCRIPTION AS ticket_description,
    cf.issue_description,
    cf.resolution_description,
    cf.root_cause_description,
    cf.rca_summary,
    cf.customer_symptom_area,
    cf.customer_symptom_reported,
    cf.severity,
    cf.conversation_type,
    cf.issue_category,
    cf.component,
    cf.root_cause,
    cf.resolution_category,
    cf.occurrence,
    cf.pipeline_number,
    cf.jira_key,
    COALESCE(tc.comments_json, ARRAY_CONSTRUCT()) AS comments_json,
    COALESCE(tc.comment_count, 0) AS comment_count
FROM HEVO_ANALYTICS.RAW.RAW_ZD_TICKETS t
JOIN target_tickets tt ON t.ID = tt.ID
LEFT JOIN custom_field_values cf ON t.ID = cf.ticket_id
LEFT JOIN ticket_comments tc ON t.ID = tc.TICKET_ID
LEFT JOIN HEVO_ANALYTICS.RAW.RAW_ZD_TICKET_METRICS tm ON t.ID = tm.TICKET_ID
LEFT JOIN HEVO_ANALYTICS.RAW.RAW_ZD_USERS u_req ON t.REQUESTER_ID = u_req.ID
LEFT JOIN HEVO_ANALYTICS.RAW.RAW_ZD_USERS u_asg ON t.ASSIGNEE_ID = u_asg.ID
LEFT JOIN HEVO_ANALYTICS.RAW.RAW_ZD_ORGANIZATIONS org ON t.ORGANIZATION_ID = org.ID
ORDER BY t.UPDATED_AT DESC
